"""Replace only an already-live isolated PIR release; preserve its units and state."""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pir_live_validation', Path(__file__).with_name('upgrade-live.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
QUERY = u.QUERY
PUBLISH = u.NEW_UNITS[1]
SOURCE = u.NEW_UNITS[0]
OWNED = (*u.OLD_UNITS, *u.NEW_UNITS)
NATIVE = 'prototype/pir-browser/target/release/zecblock-pir-fixture'
ASSETS = ('prototype/private-tx/web/app.js', 'prototype/private-tx/web/worker.js',
          'prototype/pir-browser/pkg/zecblock_pir_browser.js',
          'prototype/pir-browser/pkg/zecblock_pir_browser_bg.wasm')
ASSET_URLS = ('/app.js', '/worker.js', '/wasm/zecblock_pir_browser.js', '/wasm/zecblock_pir_browser_bg.wasm')


def fields(name, properties):
    u.require(name in OWNED, 'Refusing unrelated unit inspection')
    raw = subprocess.check_output(['systemctl', 'show', name, '--property=' + properties], text=True)
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def ctl(action, name):
    u.require(action in ('start', 'stop', 'restart') and name in (QUERY, PUBLISH),
              'Only live pilot query/publisher service changes are allowed')
    return subprocess.run(['systemctl', action, name], check=True, timeout=30)


def stopped_publisher():
    deadline = time.monotonic() + 30
    while True:
        state = fields(PUBLISH, 'ActiveState,MainPID')
        if state['ActiveState'] in ('inactive', 'failed') and state['MainPID'] == '0':
            return
        u.require(time.monotonic() < deadline, 'Live publisher did not stop')
        time.sleep(0.2)


def canonical_publication(manifest, floor):
    guard = u.source_ready(floor)
    blocks = manifest['coverage']['blocks']
    canonical = {block['height']: block['hash'] for block in guard['blocks']}
    u.require(blocks and all(canonical.get(block['height']) == block['hash'] for block in blocks),
              'Paused publication canonical membership changed')


def validate_install(previous, unit_bytes):
    drop_dir = u.UNITS / (QUERY + '.d')
    u.ordinary_directory(drop_dir)
    u.require(set(path.name for path in drop_dir.iterdir()) == {'live.conf'}, 'Unexpected query drop-ins')
    drop = drop_dir / 'live.conf'
    u.require(drop.is_file() and not drop.is_symlink() and drop.read_bytes() == u.DROP_TEXT.encode(),
              'Live query override drift')
    for name in OWNED:
        path = u.UNITS / name
        u.require(path.is_file() and not path.is_symlink(), 'Unexpected installed pilot unit')
        expected = previous / 'prototype/private-tx/pilot' / name
        u.require(path.read_bytes() == expected.read_bytes() == unit_bytes[name], 'Pilot unit drift: ' + name)
        metadata = fields(name, 'FragmentPath,DropInPaths')
        u.require(metadata.get('FragmentPath') == str(path)
                  and metadata.get('DropInPaths', '') == (str(drop) if name == QUERY else ''),
                  'Pilot unit override drift: ' + name)
    u.require(u.CONFIG.is_file() and not u.CONFIG.is_symlink(), 'Missing ordinary live config')
    config_bytes = u.CONFIG.read_bytes()
    config = json.loads(config_bytes)
    floor = config.get('startHeight')
    u.require(type(floor) is int and floor >= 0 and config == {
        'schema': 'zecblock-private-live-config-v1', 'startHeight': floor,
        'maxBlocks': 128, 'maxRecords': 2048, 'intervalMs': 1000}, 'Live config drift')
    for name in (QUERY, SOURCE, PUBLISH):
        state = fields(name, 'ActiveState,MainPID')
        u.require(state['ActiveState'] == 'active' and int(state['MainPID']) > 0, 'Live pilot unit is not active')
    timer = fields(u.TIMER, 'ActiveState')
    u.require(timer['ActiveState'] in ('inactive', 'failed'), 'Rolling publisher/timer must remain stopped')
    publisher = fields(u.PUBLISH, 'ActiveState,MainPID')
    u.require(publisher['ActiveState'] in ('inactive', 'failed') and publisher['MainPID'] == '0',
              'Rolling publisher/timer must remain stopped')
    _, manifest, _ = u.publication(u.LIVE_STATE)
    u.require(manifest['coverage']['startHeight'] == floor, 'Live publication/config floor mismatch')
    canonical_publication(manifest, floor)
    return floor, config_bytes


def loadcheck_absent(commit, phase):
    u.require(phase in ('previous', 'compact'), 'Invalid native loadcheck phase')
    name = 'zecblock-pir-pilot-loadcheck-' + commit[:12] + '-' + phase + '.service'
    raw = subprocess.check_output(['systemctl', 'show', name, '--property=LoadState'], text=True)
    u.require(raw.strip() == 'LoadState=not-found', 'Owned transient loadcheck already exists')
    return name


def native_loadcheck(release, generation, commit, phase):
    name = loadcheck_absent(commit, phase)
    properties = {
        'User': 'zecblock-pir-pilot', 'Group': 'zecblock-pir-pilot', 'Slice': 'zecblock-pir-pilot.slice',
        'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict', 'ProtectHome': 'yes', 'PrivateTmp': 'yes',
        'PrivateDevices': 'yes', 'ProtectKernelTunables': 'yes', 'ProtectKernelModules': 'yes',
        'ProtectControlGroups': 'yes', 'RestrictSUIDSGID': 'yes', 'CapabilityBoundingSet': '',
        'RestrictAddressFamilies': 'AF_UNIX', 'IPAddressDeny': 'any', 'SystemCallFilter': '~connect',
        'ReadOnlyPaths': str(u.LIVE_STATE), 'InaccessiblePaths': '/var/lib/postgresql /etc/postgresql',
        'MemoryMax': str(2 * 1024 ** 3), 'MemorySwapMax': '0', 'CPUQuota': '200%', 'TasksMax': '32',
        'RuntimeMaxSec': '60', 'TimeoutStopSec': '5', 'KillMode': 'control-group', 'OOMPolicy': 'stop', 'Nice': '15',
    }
    command = ['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '--unit=' + name,
               '--setenv=RAYON_NUM_THREADS=2', '--setenv=UV_THREADPOOL_SIZE=2']
    command += ['--property=' + key + '=' + value for key, value in properties.items()]
    command += [str(release / NATIVE), 'serve', str(generation)]
    try:
        # EOF makes serve exit only after validating manifest/database/setup and
        # constructing the evaluator. Never feed a selected transaction ID.
        result = subprocess.run(command, input=b'', stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=70, check=True)
        u.require(len(result.stderr) <= 65536 and b'Fixture evaluator ready' in result.stderr,
                  'New native evaluator did not validate the previous generation')
    except BaseException:
        subprocess.run(['systemctl', 'stop', name], check=False, timeout=15)
        raise


def probe_asset(path, expected):
    connection = http.client.HTTPConnection('127.0.0.1', 4319, timeout=2)
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        raw = response.read(expected['bytes'] + 1)
        u.require(response.status == 200 and len(raw) == expected['bytes']
                  and hashlib.sha256(raw).hexdigest() == expected['sha256'], 'Served release asset mismatch: ' + path)
    finally:
        connection.close()


def ready(floor, paused, provenance):
    u.require(u.source_ready(floor).get('captureState') == 'ready', 'Source extension is capacity-blocked')
    identifier = u.ready(floor, paused)
    _, manifest, _ = u.publication(u.LIVE_STATE)
    u.require(manifest.get('packing') == 'compact-v1' and manifest.get('coverRow') == 2047,
              'New compact generation has not been admitted')
    for name in (QUERY, SOURCE, PUBLISH):
        state = fields(name, 'ActiveState,MainPID')
        u.require(state['ActiveState'] == 'active' and int(state['MainPID']) > 0, 'Live pilot service unavailable')
    for path, url in zip(ASSETS, ASSET_URLS):
        probe_asset(url, provenance['files'][path])
    return identifier


def save_paused(directory, pointer):
    """Normal generation retention must not remove the old-binary rollback view."""
    u.absent(directory)
    directory.mkdir(mode=0o700)
    (directory / 'publications').mkdir(mode=0o700)
    generation = u.LIVE_STATE / 'publications' / pointer['publicationId']
    shutil.copytree(generation, directory / 'publications' / pointer['publicationId'])
    for name in ('current.json', 'publisher-status.json'):
        path = u.LIVE_STATE / name
        u.require(path.is_file() and not path.is_symlink(), 'Unsafe paused state file')
        (directory / name).write_bytes(path.read_bytes())
    for path in (directory, *directory.rglob('*')):
        os.chown(path, 0, 0)
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    u.publication(directory)


def restore_paused(directory):
    pointer, _, generation = u.publication(directory)
    target = u.LIVE_STATE / 'publications' / pointer['publicationId']
    owner = u.LIVE_STATE.stat()
    if target.exists() or target.is_symlink():
        u.ordinary_directory(target)
        expected = {str(path.relative_to(generation)): u.digest(path) for path in generation.rglob('*') if path.is_file()}
        actual = {}
        for path in target.rglob('*'):
            u.require(not path.is_symlink() and (path.is_file() or path.is_dir()), 'Unsafe retained rollback generation')
            if path.is_file():
                actual[str(path.relative_to(target))] = u.digest(path)
        u.require(actual == expected, 'Retained rollback generation drift')
    else:
        shutil.copytree(generation, target)
        for path in (target, *target.rglob('*')):
            os.chown(path, owner.st_uid, owner.st_gid)
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
    for name in ('current.json', 'publisher-status.json'):
        temporary = u.LIVE_STATE / ('.rollback-' + name + '-' + str(os.getpid()))
        u.absent(temporary)
        try:
            with temporary.open('xb') as output:
                output.write((directory / name).read_bytes())
                output.flush()
                os.fsync(output.fileno())
            os.chown(temporary, owner.st_uid, owner.st_gid)
            os.chmod(temporary, 0o600)
            os.replace(temporary, u.LIVE_STATE / name)
        finally:
            if temporary.exists():
                temporary.unlink()
    u.publication(u.LIVE_STATE)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('archive', 'archive_sha256', 'new_commit', 'previous_commit'):
        parser.add_argument(name, type=Path if name == 'archive' else str)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args(argv)
    u.require(os.geteuid() == 0 and u.HASH.fullmatch(args.archive_sha256)
              and all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (args.new_commit, args.previous_commit))
              and args.new_commit != args.previous_commit, 'Root and distinct exact release identities required')
    u.ordinary_directory(u.ROOT)
    u.ordinary_directory(u.ROOT / 'releases')
    previous = u.ROOT / 'releases' / args.previous_commit
    release = u.ROOT / 'releases' / args.new_commit
    backup = u.ROOT / ('live-release-rollback-' + args.previous_commit[:12] + '-' + args.new_commit[:12])
    u.require((u.ROOT / 'current').is_symlink() and (u.ROOT / 'current').resolve() == previous,
              'Unexpected previous live release')
    u.absent(release)
    u.absent(backup)
    u.absent(u.ROOT / '.upgrade-live-current')
    u.release_manifest(previous, args.previous_commit)
    provenance, unit_bytes = u.check_archive(args.archive, args.archive_sha256, args.new_commit)
    u.require(all(path in provenance['files'] for path in (*ASSETS, NATIVE)), 'Missing release runtime files')
    floor, config_bytes = validate_install(previous, unit_bytes)
    for phase in ('previous', 'compact'):
        loadcheck_absent(args.new_commit, phase)
    if args.verify_only:
        print(json.dumps({'verifiedOnly': True, 'previousCommit': args.previous_commit, 'newCommit': args.new_commit,
                          'startHeight': floor, 'filesVerified': len(provenance['files']),
                          'nativeLoadcheckDeferred': True, 'unitsAndConfigChanged': False}))
        return
    release.mkdir(mode=0o755)
    with tarfile.open(args.archive) as packed:
        packed.extractall(release, filter='data')
    u.release_manifest(release, args.new_commit)
    for path in (release, *release.rglob('*')):
        os.chown(path, 0, 0)
        os.chmod(path, 0o755 if path.is_dir() or path.name == 'zecblock-pir-fixture' else 0o644)
    switched = False
    publisher_stopped = False
    try:
        publisher_stopped = True
        ctl('stop', PUBLISH)
        stopped_publisher()
        # Freeze and revalidate after the old publisher's final write, not at preflight.
        pointer, manifest, generation = u.publication(u.LIVE_STATE)
        u.require(manifest['coverage']['startHeight'] == floor and u.CONFIG.read_bytes() == config_bytes,
                  'Live floor/config changed at cutover')
        canonical_publication(manifest, floor)
        save_paused(backup, pointer)
        native_loadcheck(release, generation, args.new_commit, 'previous')
        canonical_publication(manifest, floor)
        switched = True
        u.switch(release)
        ctl('restart', QUERY)
        ctl('start', PUBLISH)
        deadline = time.monotonic() + 90
        while True:
            try:
                identifier = ready(floor, pointer['publicationId'], provenance)
                break
            except (OSError, ValueError, KeyError, TypeError, RuntimeError, http.client.HTTPException):
                u.require(time.monotonic() < deadline, 'Live release readiness failed; rolling back')
                time.sleep(0.25)
        # Node's /health does not wait for its native child's constructor. Test
        # the final admitted compact artifact with publication paused, while
        # the source continues refreshing canonical guard observations.
        ctl('stop', PUBLISH)
        stopped_publisher()
        compact_pointer, compact_manifest, compact_generation = u.publication(u.LIVE_STATE)
        u.require(compact_pointer['publicationId'] != pointer['publicationId']
                  and compact_manifest.get('packing') == 'compact-v1'
                  and compact_manifest.get('coverRow') == 2047, 'Compact generation changed incompatibly')
        native_loadcheck(release, compact_generation, args.new_commit, 'compact')
        u.source_ready(floor)
        ctl('start', PUBLISH)
        deadline = time.monotonic() + 30
        while True:
            try:
                identifier = ready(floor, pointer['publicationId'], provenance)
                u.require(identifier == compact_pointer['publicationId'], 'Validated compact pointer changed during resume')
                break
            except (OSError, ValueError, KeyError, TypeError, RuntimeError, http.client.HTTPException):
                u.require(time.monotonic() < deadline, 'Validated compact release did not remain ready; rolling back')
                time.sleep(0.25)
    except BaseException:
        if switched:
            ctl('stop', PUBLISH)
            stopped_publisher()
            # Old native code cannot load compact manifests. Restore its exact
            # paused view, even if normal retention already pruned that view.
            restore_paused(backup)
            u.switch(previous)
            ctl('restart', QUERY)
        if publisher_stopped:
            ctl('start', PUBLISH)
        raise
    print(json.dumps({'previousCommit': args.previous_commit, 'upgradedCommit': args.new_commit,
                      'pausedPublicationId': pointer['publicationId'], 'livePublicationId': identifier,
                      'startHeight': floor, 'nativePreviousGenerationValidated': True,
                      'nativeCompactGenerationValidated': compact_pointer['publicationId'],
                      'pausedLegacyBackup': str(backup),
                      'unitsAndConfigChanged': False, 'sourceRestarted': False, 'rollingTimerStarted': False,
                      'productionServicesChanged': False}))


if __name__ == '__main__':
    main()
