"""Migrate only owned live PIR units to a guarded collection, with an explicit outage."""
import argparse
from datetime import datetime, timezone
import grp
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import subprocess
import sys
import tarfile
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pir_live_release_validation', Path(__file__).with_name('upgrade-live-release.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
u = v.u
QUERY, SOURCE, PUBLISH = v.QUERY, v.SOURCE, v.PUBLISH
SERVICES = (QUERY, PUBLISH, SOURCE)
ARCHIVE_STATE = Path('/var/lib/zecblock-pir-archive')
ARCHIVE_SOURCE = Path('/var/lib/zecblock-pir-archive-source')
ARCHIVE_CONFIG = Path('/etc/zecblock-pir-pilot/archive.json')
BOOTSTRAP_HEIGHT = 3534517
BASELINE_RECORDS = 393
TEMPLATES = {QUERY: 'archive-query.conf', SOURCE: 'archive-source.conf', PUBLISH: 'archive-publish.conf'}
CONFIG_VALUE = {'schema': 'zecblock-private-archive-config-v1', 'bootstrapHeight': BOOTSTRAP_HEIGHT, 'liveWindow': 16}
VERIFIED_ARTIFACTS = set()
VERIFIED_IDENTITIES = set()


def artifact_verified(path, expected, size):
    u.require(path.is_file() and not path.is_symlink(), 'Unsafe archive artifact')
    info = path.stat()
    u.require(info.st_size == size, 'Archive artifact size mismatch')
    key = (str(path), expected, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    if key not in VERIFIED_ARTIFACTS:
        actual = u.digest(path)
        after = path.stat()
        u.require(actual == expected and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                  == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns), 'Archive artifact verification failed')
        VERIFIED_ARTIFACTS.add(key)


def legacy_files_unchanged(previous, units, old_config):
    for name in v.OWNED:
        installed = u.UNITS / name
        u.require(installed.is_file() and not installed.is_symlink()
                  and installed.read_bytes() == units[name] == (previous / 'prototype/private-tx/pilot' / name).read_bytes(),
                  'Legacy pilot unit definition drift')
    u.require(u.CONFIG.read_bytes() == old_config
              and (u.UNITS / (QUERY + '.d/live.conf')).read_bytes() == u.DROP_TEXT.encode(), 'Legacy live controls drift')


def ctl(action, name=None):
    u.require((action in ('start', 'stop') and name in SERVICES) or (action == 'daemon-reload' and name is None),
              'Refusing any service change outside the three owned pilot services')
    return subprocess.run(['systemctl', action, *([name] if name else [])], check=True, timeout=40)


def stopped(name):
    deadline = time.monotonic() + 40
    while True:
        state = v.fields(name, 'ActiveState,MainPID')
        if state['ActiveState'] in ('inactive', 'failed') and state['MainPID'] == '0':
            return
        u.require(time.monotonic() < deadline, 'Owned pilot service did not stop: ' + name)
        time.sleep(0.2)


def bounded_json(path, maximum=8 * 1024 ** 2):
    u.require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum, 'Unsafe archive control file')
    raw = path.read_bytes()
    u.require(len(raw) <= maximum, 'Archive control file exceeded its bound')
    return json.loads(raw)


def fresh_guard(path):
    guard = bounded_json(path, 1024 ** 2)
    observed = datetime.fromisoformat(guard['observedAt'].replace('Z', '+00:00'))
    age = (datetime.now(timezone.utc) - observed).total_seconds()
    u.require(guard['schema'] == 'zecblock-private-source-guard-v1' and guard['state'] == 'ready' and -1 <= age < 10,
              'Canonical source guard is unavailable or stale')
    u.require(isinstance(guard['blocks'], list) and len(guard['blocks']) <= 2048, 'Invalid canonical guard shape')
    canonical = {}
    for block in guard['blocks']:
        height, identifier = block['height'], block['hash']
        u.require(type(height) is int and height >= 0 and height not in canonical and u.HASH.fullmatch(identifier),
                  'Invalid canonical source entry')
        canonical[height] = identifier
    return guard, canonical


def validate_identity(release, expected):
    # Bounded, network-free validation through the exact release's shared codec.
    # Run as the pilot user, with a finite heap/deadline; no source credentials.
    path = ARCHIVE_STATE / 'collection.json'
    info = path.stat()
    key = (str(release), expected, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    if key in VERIFIED_IDENTITIES:
        return
    account, group = pwd.getpwnam('zecblock-pir-pilot'), grp.getgrnam('zecblock-pir-pilot')
    code = ("import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';"
            "const{validateCollection}=await import(pathToFileURL(process.argv[1]));"
            "process.stdout.write(validateCollection(JSON.parse(readFileSync(process.argv[2],'utf8'))).collectionId)")
    result = subprocess.run(['/usr/bin/node', '--max-old-space-size=128', '--input-type=module', '-e', code,
                             str(release / 'prototype/private-tx/collection.mjs'), str(ARCHIVE_STATE / 'collection.json')],
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, user=account.pw_uid, group=group.gr_gid,
                            extra_groups=[], cwd=release / 'prototype/private-tx',
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True)
    u.require(result.stdout.decode() == expected, 'Collection changed or failed exact release validation')
    after = path.stat()
    u.require((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
              == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns), 'Collection changed during validation')
    VERIFIED_IDENTITIES.add(key)


def collection_ready(release, baseline):
    head = bounded_json(ARCHIVE_STATE / 'collection.json')
    u.require(head['schema'] == 'zecblock-private-tx-collection-v1' and u.HASH.fullmatch(head['collectionId'])
              and head['network'] == 'mainnet' and 1 <= len(head['segments']) <= 8, 'Incompatible archive collection')
    guard, canonical = fresh_guard(ARCHIVE_SOURCE / 'guard.json')
    u.require(head['coverage']['startHeight'] == BOOTSTRAP_HEIGHT
              and head['coverage']['endHeight'] == guard['tip']['height'], 'Collection has not reached the sampled live source tip')
    txids, chunks, artifacts = set(), 0, []
    for segment in head['segments']:
        identifier, manifest = segment['publicationId'], segment['manifest']
        u.require(u.HASH.fullmatch(identifier) and manifest['publicationId'] == identifier
                  and manifest['schema'] == 'zecblock-private-tx-full-v1'
                  and manifest.get('recordCodec') == 'json-context-zlib-v1'
                  and manifest.get('packing') == 'compact-v1' and manifest.get('coverRow') == 2047,
                  'Collection does not contain admitted new-codec segments')
        u.require(type(manifest['chunkCount']) is int and 1 <= manifest['chunkCount'] <= 64, 'Invalid archive batch')
        chunks += manifest['chunkCount']
        for block in manifest['coverage']['blocks']:
            u.require(canonical.get(block['height']) == block['hash'], 'Archive canonical membership changed')
        u.require(canonical.get(manifest['snapshot']['height']) == manifest['snapshot']['hash'], 'Archive observation anchor changed')
        artifacts.append((ARCHIVE_STATE / 'segments' / identifier, manifest))
        for entry in manifest['catalogue']:
            u.require(u.HASH.fullmatch(entry['txid']) and entry['txid'] not in txids, 'Duplicate archive transaction')
            txids.add(entry['txid'])
    u.require(chunks <= 64 and baseline <= txids, 'Original live cohort was lost or transport capacity exceeded')
    for directory, manifest in artifacts:
        u.ordinary_directory(directory)
        u.require(bounded_json(directory / 'manifest.json') == manifest, 'Archive immutable manifest drift')
        for name, field, size in [('database.bin', 'databaseSha256', 16777216), ('public.bin', 'publicSha256', 45056)]:
            artifact_verified(directory / name, manifest[field], size)
    status = bounded_json(ARCHIVE_STATE / 'publisher-status.json', 128 * 1024)
    u.require(status['state'] == 'ready' and status['collectionId'] == head['collectionId'], 'Archive publisher is not ready')
    for name in (SOURCE, PUBLISH):
        state = v.fields(name, 'ActiveState,MainPID')
        u.require(state['ActiveState'] == 'active' and int(state['MainPID']) > 0, 'Archive service unavailable')
    validate_identity(release, head['collectionId'])
    u.require((ARCHIVE_STATE / 'collection.json').stat().st_mode & 0o777 == 0o640, 'Collection control is not group-readable')
    return head


def wait_until(operation, seconds, message):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return operation()
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError, http.client.HTTPException):
            u.require(time.monotonic() < deadline, message)
            time.sleep(0.25)


def query_ready(head, provenance):
    u.require(u.probe_health().get('publicationId') == head['collectionId'], 'Query did not load the admitted collection')
    for path, url in zip(v.ASSETS, v.ASSET_URLS):
        v.probe_asset(url, provenance['files'][path])
    state = v.fields(QUERY, 'ActiveState,MainPID')
    u.require(state['ActiveState'] == 'active' and int(state['MainPID']) > 0, 'Query service is not running')
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('archive', 'archive_sha256', 'new_commit', 'previous_commit'):
        parser.add_argument(name, type=Path if name == 'archive' else str)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args(argv)
    u.require(os.geteuid() == 0 and u.HASH.fullmatch(args.archive_sha256)
              and all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (args.new_commit, args.previous_commit))
              and args.new_commit != args.previous_commit, 'Root and distinct exact release identities required')
    previous, release = [u.ROOT / 'releases' / identifier for identifier in (args.previous_commit, args.new_commit)]
    backup = u.ROOT / ('archive-upgrade-' + args.new_commit[:12])
    u.ordinary_directory(u.ROOT); u.ordinary_directory(u.ROOT / 'releases')
    u.require((u.ROOT / 'current').is_symlink() and (u.ROOT / 'current').resolve() == previous, 'Unexpected previous live release')
    for path in (release, backup, ARCHIVE_STATE, ARCHIVE_SOURCE, ARCHIVE_CONFIG, u.ROOT / '.upgrade-live-current'):
        u.absent(path)
    u.release_manifest(previous, args.previous_commit)
    provenance, units = u.check_archive(args.archive, args.archive_sha256, args.new_commit)
    required = [*v.ASSETS, v.NATIVE, 'prototype/private-tx/native-evaluator.mjs', 'prototype/private-tx/collection.mjs', 'prototype/private-tx/collection-server.mjs', 'prototype/private-tx/state-files.mjs',
                'prototype/private-tx/pilot/archive-source.mjs', 'prototype/private-tx/pilot/archive-watch.mjs',
                'prototype/private-tx/pilot/publish-archive.mjs']
    u.require(all(name in provenance['files'] for name in required), 'Incomplete archive runtime closure')
    floor, old_config = v.validate_install(previous, units)
    pointer, manifest, _ = u.publication(u.LIVE_STATE)
    baseline = {entry['txid'] for entry in manifest['catalogue']}
    u.require(floor == BOOTSTRAP_HEIGHT and len(baseline) == BASELINE_RECORDS, 'Unexpected original live cohort or floor')
    templates = {}
    with tarfile.open(args.archive) as packed:
        members = {}
        for member in packed.getmembers():
            u.require(member.isfile() or member.isdir(), 'Unsafe archive template member type')
            if member.isdir() and PurePosixPath(member.name) == PurePosixPath('.'):
                continue
            normalized = u.relative_file(member.name)
            u.require(normalized not in members, 'Duplicate normalized archive template path')
            members[normalized] = member
        for name, template in TEMPLATES.items():
            path = 'prototype/private-tx/pilot/' + template
            u.require(path in provenance['files'], 'Archive service template missing from closed release')
            member = members.get(path)
            expected = provenance['files'][path]
            u.require(member is not None and member.isfile() and member.size == expected['bytes'], 'Invalid archive service template member')
            templates[name] = packed.extractfile(member).read()
            u.require(hashlib.sha256(templates[name]).hexdigest() == expected['sha256'], 'Archive service template hash mismatch')
    for name in SERVICES:
        directory = u.UNITS / (name + '.d')
        if directory.exists() or directory.is_symlink():
            u.ordinary_directory(directory)
        u.absent(directory / 'zz-archive.conf')
    for phase in ('previous', 'compact'):
        v.loadcheck_absent(args.new_commit, phase)
    account, postgres, group = pwd.getpwnam('zecblock-pir-pilot'), pwd.getpwnam('postgres'), grp.getgrnam('zecblock-pir-pilot')
    u.require(account.pw_uid != 0 and postgres.pw_uid != 0, 'Unprivileged runtime users required')
    before = {name: v.fields(name, 'ActiveState,MainPID,UnitFileState') for name in SERVICES}
    if args.verify_only:
        print(json.dumps({'verifiedOnly': True, 'previousCommit': args.previous_commit, 'newCommit': args.new_commit,
                          'baselineRecords': len(baseline), 'config': CONFIG_VALUE, 'pilotOutageRequired': True,
                          'serviceOperationAllowlist': list(SERVICES), 'unitsAndLegacyConfigPreserved': True}))
        return
    release.mkdir(mode=0o755)
    with tarfile.open(args.archive) as packed:
        packed.extractall(release, filter='data')
    u.release_manifest(release, args.new_commit)
    for path in (release, *release.rglob('*')):
        os.chown(path, 0, 0); os.chmod(path, 0o755 if path.is_dir() or path.name == 'zecblock-pir-fixture' else 0o644)
    backup.mkdir(mode=0o700)
    u.write_owned(backup / 'before.json', (json.dumps({'previousCommit': args.previous_commit, 'pointer': pointer,
                  'services': before, 'originalTxids': sorted(baseline), 'liveConfigSha256': hashlib.sha256(old_config).hexdigest()}) + '\n').encode(), 0, 0, 0o600)
    u.write_owned(backup / 'live.json', old_config, 0, 0, 0o600)
    u.write_owned(backup / 'live.conf', (u.UNITS / (QUERY + '.d/live.conf')).read_bytes(), 0, 0, 0o600)
    changed, created_dirs, switched = [], [], False
    paused = pointer
    began = time.monotonic()
    try:
        for name in SERVICES:
            ctl('stop', name); stopped(name)
        paused, frozen, _ = u.publication(u.LIVE_STATE)
        u.require(baseline <= {entry['txid'] for entry in frozen['catalogue']} and u.CONFIG.read_bytes() == old_config,
                  'Old live state/config changed before cutover')
        v.native_loadcheck(release, u.LIVE_STATE / 'publications' / paused['publicationId'], args.new_commit, 'previous')
        for directory, uid in ((ARCHIVE_STATE, account.pw_uid), (ARCHIVE_SOURCE, postgres.pw_uid)):
            directory.mkdir(mode=0o750); os.chown(directory, uid, group.gr_gid); os.chmod(directory, 0o750)
        request = {'schema': 'zecblock-private-capture-request-v1', 'startHeight': BOOTSTRAP_HEIGHT}
        u.write_owned(ARCHIVE_STATE / 'capture-request.json', (json.dumps(request) + '\n').encode(), account.pw_uid, group.gr_gid, 0o640)
        config_bytes = (json.dumps(CONFIG_VALUE, indent=2) + '\n').encode()
        u.write_owned(ARCHIVE_CONFIG, config_bytes, 0, 0, 0o644); changed.append((ARCHIVE_CONFIG, config_bytes))
        for name, data in templates.items():
            directory = u.UNITS / (name + '.d')
            if not directory.exists():
                directory.mkdir(mode=0o755); os.chmod(directory, 0o755); created_dirs.append(directory)
            target = directory / 'zz-archive.conf'
            u.write_owned(target, data, 0, 0, 0o644); changed.append((target, data))
        ctl('daemon-reload')
        switched = True; u.switch(release)
        ctl('start', SOURCE); ctl('start', PUBLISH)
        head = wait_until(lambda: collection_ready(release, baseline), 180, 'Archive source/publication readiness failed')
        # Native constructor checks the actual new codec before exposing query.
        # Check the actual new format/profile before exposing query; all-segment
        # encrypted browser acceptance remains a separate release check. Source
        # and publisher continue; the query pool is still stopped, and the
        # explicit immutable segment remains pinned by retained collection heads.
        segment = head['segments'][0]
        v.native_loadcheck(release, ARCHIVE_STATE / 'segments' / segment['publicationId'], args.new_commit, 'compact')
        wait_until(lambda: collection_ready(release, baseline), 30, 'Archive did not remain ready after native validation')
        ctl('start', QUERY)
        def active():
            current = collection_ready(release, baseline)
            query_ready(current, provenance)
            return current
        head = wait_until(active, 30, 'Archive query readiness failed')
        legacy_files_unchanged(previous, units, old_config)
    except BaseException as original:
        rollback_ok = False
        try:
            for name in SERVICES:
                ctl('stop', name); stopped(name)
            for path, data in reversed(changed):
                u.require(path.is_file() and not path.is_symlink() and path.read_bytes() == data, 'Rollback refuses changed owned archive file')
                path.unlink()
            for directory in reversed(created_dirs):
                directory.rmdir()
            if switched: u.switch(previous)
            if changed: ctl('daemon-reload')
            ctl('start', SOURCE); ctl('start', PUBLISH)
            wait_until(lambda: u.source_ready(BOOTSTRAP_HEIGHT), 60, 'Previous source guard did not recover')
            ctl('start', QUERY)
            def restored():
                u.require(u.probe_health().get('publicationId') == paused['publicationId'], 'Previous query publication not restored')
                return True
            wait_until(restored, 30, 'Previous query readiness was not restored')
            legacy_files_unchanged(previous, units, old_config)
            v.validate_install(previous, units)
            u.require((u.ROOT / 'current').resolve() == previous, 'Previous release symlink was not restored')
            rollback_ok = True
        finally:
            u.write_owned(backup / 'rollback.json', (json.dumps({'verified': rollback_ok, 'pilotOutageSeconds': time.monotonic() - began,
                          'failedArchiveStatePreserved': str(ARCHIVE_STATE), 'failedArchiveSourcePreserved': str(ARCHIVE_SOURCE)}) + '\n').encode(), 0, 0, 0o600)
        raise original
    print(json.dumps({'previousCommit': args.previous_commit, 'upgradedCommit': args.new_commit,
                      'collectionId': head['collectionId'], 'originalRecordsRetained': len(baseline),
                      'coverage': {key: value for key, value in head['coverage'].items() if key != 'blocks'},
                      'pilotOutageSeconds': time.monotonic() - began,
                      'backup': str(backup), 'serviceOperationAllowlist': list(SERVICES),
                      'legacyStateAndConfigPreserved': True, 'bootEnablementChanged': False}))


if __name__ == '__main__':
    main()
