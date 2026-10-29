"""Install only the isolated pilot files. Does not start/enable any service."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tarfile

archive, expected_sha, expected_commit = sys.argv[1:]
if os.geteuid() != 0 or not re.fullmatch(r'[a-f0-9]{64}', expected_sha) or not re.fullmatch(r'[a-f0-9]{40}', expected_commit):
    raise SystemExit('Root, exact archive SHA-256 and exact source commit required.')
archive = Path(archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_sha:
    raise SystemExit('Archive hash mismatch.')
root = Path('/opt/zecblock-pir-pilot')
release = root / 'releases' / expected_commit
state = Path('/var/lib/zecblock-pir-pilot')
current = root / 'current'
units = ['zecblock-pir-pilot.slice', 'zecblock-pir-pilot.service', 'zecblock-pir-pilot-publish.service', 'zecblock-pir-pilot-publish.timer']
unit_paths = [Path('/etc/systemd/system') / n for n in units]
for p in [root, root / 'releases', state, current, *unit_paths]:
    if p.is_symlink():
        raise SystemExit('Symlinked pilot install path; inspect before continuing: ' + str(p))
for p in [state, current, *unit_paths]:
    if p.exists():
        raise SystemExit('Existing pilot install path; inspect before continuing: ' + str(p))
user = 'zecblock-pir-pilot'
try:
    pwd.getpwnam(user)
except KeyError:
    pass
else:
    raise SystemExit('Pilot account already exists; inspect before continuing.')
if release.exists():
    raise SystemExit('Release already exists; inspect it rather than overwriting.')
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        p = Path(member.name)
        if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe archive member.')
    release.mkdir(parents=True, mode=0o755)
    tar.extractall(release, filter='data')
provenance = json.loads((release / 'provenance.json').read_text())
if provenance['commit'] != expected_commit:
    raise SystemExit('Source commit mismatch.')
for name, expected in provenance['files'].items():
    p = Path(name)
    if p.is_absolute() or '..' in p.parts:
        raise SystemExit('Unsafe provenance path.')
    data = (release / p).read_bytes()
    if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
        raise SystemExit('Release content verification failed: ' + name)
for p in [release, *release.rglob('*')]:
    os.chown(p, 0, 0)
    os.chmod(p, 0o755 if p.is_dir() or p.name == 'zecblock-pir-fixture' else 0o644)
subprocess.run(['systemd-analyze', 'verify', *[str(release / 'prototype/private-tx/pilot' / n) for n in units]], check=True)
subprocess.run(['useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', user], check=True)
account = pwd.getpwnam(user)
if account.pw_uid == 0 or account.pw_shell != '/usr/sbin/nologin':
    raise SystemExit('Unexpected pilot account; inspect before continuing.')
state.mkdir(mode=0o700)
os.chown(state, account.pw_uid, account.pw_gid)
os.chmod(state, 0o700)
for name in units:
    target = Path('/etc/systemd/system') / name
    source = release / 'prototype/private-tx/pilot' / name
    shutil.copyfile(source, target)
    os.chmod(target, 0o644)
current.symlink_to(release)
subprocess.run(['systemd-analyze', 'verify', *[str(Path('/etc/systemd/system') / n) for n in units]], check=True)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
print(json.dumps({'installedCommit': expected_commit, 'release': str(release), 'state': str(state), 'runtimeUser': user, 'started': False, 'enabled': False}))
