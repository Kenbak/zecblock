"""Migrate only the owned PIR pilot; the rolling state remains a rollback copy."""
import argparse
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import subprocess
import tarfile
import time
from datetime import datetime, timezone

ROOT = Path('/opt/zecblock-pir-pilot')
OLD_STATE = Path('/var/lib/zecblock-pir-pilot')
LIVE_STATE = Path('/var/lib/zecblock-pir-live')
SOURCE_STATE = Path('/var/lib/zecblock-pir-source')
UNITS = Path('/etc/systemd/system')
CONFIG = Path('/etc/zecblock-pir-pilot/live.json')
QUERY = 'zecblock-pir-pilot.service'
PUBLISH = 'zecblock-pir-pilot-publish.service'
TIMER = 'zecblock-pir-pilot-publish.timer'
OLD_UNITS = (QUERY, PUBLISH, TIMER, 'zecblock-pir-pilot.slice')
NEW_UNITS = ('zecblock-pir-pilot-source.service', 'zecblock-pir-pilot-live-publish.service')
DROP_TEXT = '[Service]\nEnvironment=PRIVATE_TX_LOCAL_DIR=/var/lib/zecblock-pir-live\nEnvironment=PRIVATE_TX_SOURCE_DIR=/var/lib/zecblock-pir-source\n'
HASH = re.compile(r'[a-f0-9]{64}')
MAX_FILE = 128 * 1024 ** 2
MAX_ARCHIVE = 256 * 1024 ** 2


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def absent(path):
    require(not path.exists() and not path.is_symlink(), 'Reserved migration path already exists: ' + str(path))


def ordinary_directory(path):
    require(path.is_dir() and not path.is_symlink(), 'Expected an ordinary directory: ' + str(path))


def relative_file(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and '..' not in path.parts and str(path) != '.', 'Unsafe release path')
    return str(path)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for part in iter(lambda: source.read(65536), b''):
            result.update(part)
    return result.hexdigest()


def release_manifest(directory, expected_commit):
    ordinary_directory(directory)
    provenance = json.loads((directory / 'provenance.json').read_text())
    require(provenance['commit'] == expected_commit, 'Release source identity mismatch')
    expected = provenance['files']
    require(isinstance(expected, dict) and 1 <= len(expected) <= 512, 'Invalid closed release inventory')
    actual = set()
    for path in directory.rglob('*'):
        require(not path.is_symlink(), 'Release contains a symbolic link')
        if path.is_file():
            actual.add(str(path.relative_to(directory)))
        else:
            require(path.is_dir(), 'Release contains a nonordinary file')
    require(actual == set(expected) | {'provenance.json'}, 'Release inventory is not closed')
    for name, facts in expected.items():
        relative_file(name)
        path = directory / name
        require(type(facts['bytes']) is int and 0 <= facts['bytes'] <= MAX_FILE, 'Invalid release file size')
        require(HASH.fullmatch(facts['sha256']) and path.stat().st_size == facts['bytes']
                and digest(path) == facts['sha256'], 'Release file hash mismatch: ' + name)
    return provenance


def check_archive(archive, expected_sha, expected_commit):
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= MAX_ARCHIVE,
            'Invalid or oversized release archive')
    require(digest(archive) == expected_sha, 'Archive hash mismatch')
    with tarfile.open(archive) as packed:
        members, files, seen, total = [], {}, set(), 0
        for member in packed.getmembers():
            require(member.isfile() or member.isdir(), 'Unsafe archive member type')
            if member.isdir() and PurePosixPath(member.name) == PurePosixPath('.'):
                continue
            name = relative_file(member.name)
            require(name not in seen, 'Duplicate archive path')
            seen.add(name)
            require(0 <= member.size <= MAX_FILE, 'Oversized archive member')
            total += member.size
            require(total <= MAX_ARCHIVE, 'Oversized unpacked release')
            members.append(member)
            if member.isfile():
                files[name] = member
        require('provenance.json' in files, 'Missing provenance')
        provenance = json.load(packed.extractfile(files['provenance.json']))
        require(provenance['commit'] == expected_commit, 'New release source identity mismatch')
        require(set(files) == set(provenance['files']) | {'provenance.json'}, 'Archive inventory is not closed')
        for name, facts in provenance['files'].items():
            relative_file(name)
            require(type(facts['bytes']) is int and files[name].size == facts['bytes'], 'Archive file size mismatch')
            raw = packed.extractfile(files[name]).read()
            require(HASH.fullmatch(facts['sha256']) and hashlib.sha256(raw).hexdigest() == facts['sha256'],
                    'Archive file hash mismatch: ' + name)
        required = ['prototype/private-tx/pilot/' + name for name in (*OLD_UNITS, *NEW_UNITS)]
        require(all(name in files for name in required), 'Missing owned pilot units')
        unit_bytes = {name: packed.extractfile(files['prototype/private-tx/pilot/' + name]).read()
                      for name in (*OLD_UNITS, *NEW_UNITS)}
    return provenance, unit_bytes


def ctl(action, *names, check=True):
    require(all(name in (*OLD_UNITS, *NEW_UNITS) for name in names), 'Refusing an unrelated service operation')
    require(action in ['show', 'is-active', 'start', 'stop', 'restart', 'daemon-reload'], 'Refusing an unrelated manager operation')
    require(action != 'daemon-reload' or not names, 'Invalid reload operation')
    args = ['systemctl', action]
    if action == 'is-active':
        args.append('--quiet')
    return subprocess.run([*args, *names], check=check)


def unit_fields(name, properties):
    require(name in OLD_UNITS, 'Only owned old unit inspection is allowed')
    raw = subprocess.check_output(['systemctl', 'show', name, '--property=' + properties], text=True)
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def publication(state):
    ordinary_directory(state)
    pointer = state / 'current.json'
    require(pointer.is_file() and not pointer.is_symlink(), 'Invalid publication pointer file')
    value = json.loads(pointer.read_text())
    identifier = value['publicationId']
    require(isinstance(identifier, str) and HASH.fullmatch(identifier) and value['directory'] == identifier,
            'Invalid publication pointer')
    directory = state / 'publications' / identifier
    ordinary_directory(state / 'publications')
    ordinary_directory(directory)
    for path in directory.rglob('*'):
        require(not path.is_symlink() and (path.is_file() or path.is_dir()), 'Unsafe publication file')
    manifest = json.loads((directory / 'manifest.json').read_text())
    require(manifest['schema'] == 'zecblock-private-tx-full-v1' and manifest['publicationId'] == identifier,
            'Incompatible publication')
    require(type(manifest['chunkCount']) is int and 1 <= manifest['chunkCount'] <= 64, 'Unsupported batch admission')
    for key in ['startHeight', 'endHeight']:
        require(type(manifest['coverage'][key]) is int and manifest['coverage'][key] >= 0, 'Invalid coverage')
    require(manifest['coverage']['startHeight'] <= manifest['coverage']['endHeight'], 'Invalid coverage range')
    for name, field in [('database.bin', 'databaseSha256'), ('public.bin', 'publicSha256')]:
        path = directory / name
        require(path.is_file() and path.stat().st_size <= MAX_FILE and digest(path) == manifest[field],
                'Publication artifact hash mismatch')
    return value, manifest, directory


def switch(target):
    temporary = ROOT / '.upgrade-live-current'
    absent(temporary)
    temporary.symlink_to(target)
    try:
        os.replace(temporary, ROOT / 'current')
    finally:
        if temporary.is_symlink() and temporary.readlink() == target:
            temporary.unlink()


def write_owned(path, data, uid, gid, mode):
    absent(path)
    temporary = path.with_name('.' + path.name + '.migration-' + str(os.getpid()))
    absent(temporary)
    try:
        with temporary.open('xb') as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.chown(temporary, uid, gid)
        os.chmod(temporary, mode)
        absent(path)
        temporary.rename(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def probe_health():
    connection = http.client.HTTPConnection('127.0.0.1', 4319, timeout=2)
    try:
        connection.request('GET', '/health')
        response = connection.getresponse()
        data = response.read(131073)
        require(response.status == 200 and len(data) <= 131072, 'Pilot health unavailable')
        return json.loads(data)
    finally:
        connection.close()


def source_ready(floor):
    guard_path = SOURCE_STATE / 'guard.json'
    require(not guard_path.is_symlink() and guard_path.stat().st_size <= 1024 ** 2, 'Unsafe source guard')
    guard = json.loads(guard_path.read_text())
    require(guard['schema'] == 'zecblock-private-source-guard-v1' and guard['state'] == 'ready', 'Source is not ready')
    observed = datetime.fromisoformat(guard['observedAt'].replace('Z', '+00:00'))
    age = (datetime.now(timezone.utc) - observed).total_seconds()
    require(0 <= age < 10 and guard['startHeight'] == floor, 'Source floor/freshness mismatch')
    require(HASH.fullmatch(guard['fingerprint']), 'Invalid source fingerprint')
    latest_path = SOURCE_STATE / 'latest.json'
    require(not latest_path.is_symlink() and latest_path.stat().st_size <= MAX_FILE, 'Unsafe source snapshot')
    latest = json.loads(latest_path.read_text())
    require(latest['fingerprint'] == guard['fingerprint'], 'Source guard/snapshot mismatch')
    second = json.loads(guard_path.read_text())
    require(second['fingerprint'] == guard['fingerprint'] and second['state'] == 'ready', 'Source changed during admission')
    return guard


def ready(floor, seed):
    guard = source_ready(floor)
    pointer, manifest, _ = publication(LIVE_STATE)
    require(pointer['publicationId'] != seed and manifest['coverage']['startHeight'] == floor,
            'Fresh live publication has not replaced seed')
    end = manifest['coverage']['endHeight']
    require(end == manifest['snapshot']['height'] and manifest['coverage']['complete'] is True,
            'Live publication is partial or delayed by confirmation depth')
    blocks = manifest['coverage']['blocks']
    require([block['height'] for block in blocks] == list(range(floor, end + 1)), 'Live coverage is not contiguous')
    canonical = {block['height']: block['hash'] for block in guard['blocks']}
    require(all(canonical.get(block['height']) == block['hash'] for block in blocks)
            and canonical.get(end) == manifest['snapshot']['hash'], 'Live/source canonical identity mismatch')
    status = json.loads((LIVE_STATE / 'publisher-status.json').read_text())
    require(status['state'] == 'ready' and status['publicationId'] == pointer['publicationId'], 'Live publisher is unavailable')
    require(probe_health().get('publicationId') == pointer['publicationId'], 'Query service has not loaded live state')
    return pointer['publicationId']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('archive_sha256')
    parser.add_argument('new_commit')
    parser.add_argument('previous_commit')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args(argv)
    require(os.geteuid() == 0 and HASH.fullmatch(args.archive_sha256)
            and all(re.fullmatch(r'[a-f0-9]{40}', value) for value in [args.new_commit, args.previous_commit]),
            'Root and exact archive/previous/new identities required')
    ordinary_directory(ROOT)
    ordinary_directory(ROOT / 'releases')
    previous = ROOT / 'releases' / args.previous_commit
    release = ROOT / 'releases' / args.new_commit
    current = ROOT / 'current'
    require(current.is_symlink() and current.resolve() == previous, 'Unexpected previous pilot release')
    old = release_manifest(previous, args.previous_commit)
    new, unit_bytes = check_archive(args.archive, args.archive_sha256, args.new_commit)
    drop_dir = UNITS / (QUERY + '.d')
    drop_in = drop_dir / 'live.conf'
    for path in [release, LIVE_STATE, SOURCE_STATE, CONFIG, ROOT / '.upgrade-live-current']:
        absent(path)
    for directory in [CONFIG.parent, drop_dir]:
        if directory.exists() or directory.is_symlink():
            ordinary_directory(directory)
    require(not drop_dir.exists() or not any(drop_dir.iterdir()), 'Existing query drop-ins require review')
    for name in OLD_UNITS:
        installed = UNITS / name
        require(installed.is_file() and not installed.is_symlink(), 'Unexpected installed pilot unit')
        expected = previous / 'prototype/private-tx/pilot' / name
        require(installed.read_bytes() == expected.read_bytes() == unit_bytes[name], 'Old pilot unit drift: ' + name)
        fields = unit_fields(name, 'FragmentPath,DropInPaths')
        require(fields['FragmentPath'] == str(installed) and not fields.get('DropInPaths'), 'Pilot unit override requires review')
    for name in NEW_UNITS:
        absent(UNITS / name)
    _, observed, _ = publication(OLD_STATE)
    account, postgres = pwd.getpwnam('zecblock-pir-pilot'), pwd.getpwnam('postgres')
    group = grp.getgrnam('zecblock-pir-pilot').gr_gid
    require(account.pw_uid != 0 and postgres.pw_uid != 0, 'Unprivileged runtime accounts required')
    if args.verify_only:
        print(json.dumps({'verifiedOnly': True, 'previousCommit': args.previous_commit, 'newCommit': args.new_commit,
                          'newUnitSha256': {name: hashlib.sha256(unit_bytes[name]).hexdigest() for name in NEW_UNITS},
                          'floorAtPreflight': observed['coverage']['startHeight'], 'floorRevalidatedAtCutover': True,
                          'filesVerified': len(new['files']), 'productionServicesChanged': False}))
        return
    release.mkdir(mode=0o755)
    with tarfile.open(args.archive) as packed:
        packed.extractall(release, filter='data')
    release_manifest(release, args.new_commit)
    for path in [release, *release.rglob('*')]:
        os.chown(path, 0, 0)
        os.chmod(path, 0o755 if path.is_dir() or path.name == 'zecblock-pir-fixture' else 0o644)
    subprocess.run(['systemd-analyze', 'verify', *[str(release / 'prototype/private-tx/pilot' / name) for name in NEW_UNITS]], check=True)
    timer_active = ctl('is-active', TIMER, check=False).returncode == 0
    created_units, created_files, created_directories = [], [], []
    switched = False
    stopped_timer = False
    try:
        stopped_timer = True
        ctl('stop', TIMER)
        deadline = time.monotonic() + 120
        while True:
            fields = unit_fields(PUBLISH, 'ActiveState,MainPID')
            if fields['ActiveState'] in ['inactive', 'failed'] and fields['MainPID'] == '0':
                break
            require(time.monotonic() < deadline, 'Old pilot publisher did not finish')
            time.sleep(0.2)
        seed, manifest, generation = publication(OLD_STATE)
        floor = manifest['coverage']['startHeight']
        LIVE_STATE.mkdir(mode=0o700)
        (LIVE_STATE / 'publications').mkdir(mode=0o700)
        shutil.copytree(generation, LIVE_STATE / 'publications' / seed['publicationId'])
        (LIVE_STATE / 'current.json').write_text(json.dumps(seed) + '\n')
        (LIVE_STATE / 'publisher-status.json').write_text(json.dumps({'state': 'stale', 'publicationId': seed['publicationId'],
            'lastSuccessAt': manifest['snapshot']['publishedAt'], 'message': 'Live publication has not completed.'}) + '\n')
        for path in [LIVE_STATE, *LIVE_STATE.rglob('*')]:
            os.chown(path, account.pw_uid, group)
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        SOURCE_STATE.mkdir(mode=0o750)
        os.chown(SOURCE_STATE, postgres.pw_uid, group)
        os.chmod(SOURCE_STATE, 0o750)
        for directory in [CONFIG.parent, drop_dir]:
            if not directory.exists():
                directory.mkdir(mode=0o755)
                os.chmod(directory, 0o755)
                created_directories.append(directory)
        config = {'schema': 'zecblock-private-live-config-v1', 'startHeight': floor,
                  'maxBlocks': 128, 'maxRecords': 2048, 'intervalMs': 1000}
        config_bytes = (json.dumps(config, indent=2) + '\n').encode()
        write_owned(CONFIG, config_bytes, 0, 0, 0o644)
        created_files.append((CONFIG, config_bytes))
        drop_bytes = DROP_TEXT.encode()
        write_owned(drop_in, drop_bytes, 0, 0, 0o644)
        created_files.append((drop_in, drop_bytes))
        for name in NEW_UNITS:
            target = UNITS / name
            write_owned(target, unit_bytes[name], 0, 0, 0o644)
            created_units.append((target, unit_bytes[name]))
        ctl('daemon-reload')
        switched = True
        switch(release)
        deadline = time.monotonic() + 180
        ctl('start', NEW_UNITS[0])
        while True:
            try:
                source_ready(floor)
                break
            except (OSError, ValueError, KeyError, TypeError, RuntimeError):
                require(time.monotonic() < deadline, 'Live source readiness failed; previous pilot will be restored')
                time.sleep(0.25)
        ctl('restart', QUERY)
        ctl('start', NEW_UNITS[1])
        while True:
            try:
                live_id = ready(floor, seed['publicationId'])
                require(all(ctl('is-active', name, check=False).returncode == 0 for name in NEW_UNITS), 'New pilot units are not active')
                break
            except (OSError, ValueError, KeyError, TypeError, RuntimeError):
                require(time.monotonic() < deadline, 'Live pilot readiness failed; previous pilot will be restored')
                time.sleep(0.25)
    except BaseException:
        for name in reversed(NEW_UNITS):
            if any(path.name == name for path, _ in created_units):
                ctl('stop', name)
        for path, expected in reversed([*created_units, *created_files]):
            if path.exists() or path.is_symlink():
                require(not path.is_symlink() and path.read_bytes() == expected, 'Rollback refuses a changed owned file: ' + str(path))
                path.unlink()
        for directory in reversed(created_directories):
            directory.rmdir()
        if created_units or created_files:
            ctl('daemon-reload')
        if switched:
            switch(previous)
            ctl('restart', QUERY)
        if stopped_timer and timer_active:
            ctl('start', TIMER)
        raise
    print(json.dumps({'previousCommit': args.previous_commit, 'upgradedCommit': args.new_commit,
                      'seedPublicationId': seed['publicationId'], 'livePublicationId': live_id, 'startHeight': floor,
                      'oldStatePreserved': str(OLD_STATE), 'liveState': str(LIVE_STATE), 'sourceState': str(SOURCE_STATE),
                      'oldTimerActive': False, 'newUnitsStarted': list(NEW_UNITS), 'bootEnablementChanged': False,
                      'productionServicesChanged': False}))


if __name__ == '__main__':
    main()
