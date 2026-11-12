"""Upgrade only an existing isolated pilot; retain its immutable previous release."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time
import urllib.request
from urllib.error import URLError

archive, expected_sha, new_commit, previous_commit = sys.argv[1:]
if os.geteuid() != 0 or not re.fullmatch(r'[a-f0-9]{64}', expected_sha) or not all(re.fullmatch(r'[a-f0-9]{40}', value) for value in [new_commit, previous_commit]):
    raise SystemExit('Root and exact archive/previous/new identities required.')
root = Path('/opt/zecblock-pir-pilot')
current = root / 'current'
previous = root / 'releases' / previous_commit
release = root / 'releases' / new_commit
state = Path('/var/lib/zecblock-pir-pilot')
temporary = root / '.upgrade-current'
if root.is_symlink() or state.is_symlink() or not current.is_symlink() or current.resolve() != previous or release.exists() or release.is_symlink() or temporary.exists() or temporary.is_symlink():
    raise SystemExit('Unexpected pilot layout; inspect before changing anything.')
if json.loads((previous / 'provenance.json').read_text())['commit'] != previous_commit:
    raise SystemExit('Previous release identity mismatch.')
def validate_current_publication():
    pointer = json.loads((state / 'current.json').read_text())
    if not re.fullmatch(r'[a-f0-9]{64}', pointer['directory']) or pointer['directory'] != pointer['publicationId']:
        raise RuntimeError('Invalid pilot publication pointer.')
    manifest = json.loads((state / 'publications' / pointer['directory'] / 'manifest.json').read_text())
    if not 1 <= manifest['chunkCount'] <= 64:
        raise RuntimeError('Current publication exceeds the new browser batch admission.')

validate_current_publication()
archive = Path(archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_sha:
    raise SystemExit('Archive hash mismatch.')
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        p = Path(member.name)
        if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe archive member.')
    release.mkdir(mode=0o755)
    tar.extractall(release, filter='data')
provenance = json.loads((release / 'provenance.json').read_text())
if provenance['commit'] != new_commit:
    raise SystemExit('New release identity mismatch.')
for name, expected in provenance['files'].items():
    p = Path(name)
    if p.is_absolute() or '..' in p.parts:
        raise SystemExit('Unsafe provenance path.')
    data = (release / p).read_bytes()
    if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
        raise SystemExit('Release verification failed: ' + name)
for name in ['zecblock-pir-pilot.slice', 'zecblock-pir-pilot.service', 'zecblock-pir-pilot-publish.service', 'zecblock-pir-pilot-publish.timer']:
    installed = Path('/etc/systemd/system') / name
    if installed.is_symlink() or installed.read_bytes() != (release / 'prototype/private-tx/pilot' / name).read_bytes():
        raise SystemExit('This upgrade cannot change unit definitions: ' + name)
for p in [release, *release.rglob('*')]:
    os.chown(p, 0, 0)
    os.chmod(p, 0o755 if p.is_dir() or p.name == 'zecblock-pir-fixture' else 0o644)

def systemctl(*args):
    return subprocess.run(['systemctl', *args], check=True)

def activate(target):
    temporary.symlink_to(target)
    os.replace(temporary, current)
    systemctl('restart', 'zecblock-pir-pilot.service')

timer_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'zecblock-pir-pilot-publish.timer']).returncode == 0
switched = False
try:
    systemctl('stop', 'zecblock-pir-pilot-publish.timer')
    deadline = time.monotonic() + 120
    while True:
        raw = subprocess.check_output(['systemctl', 'show', 'zecblock-pir-pilot-publish.service', '--property=ActiveState,MainPID'], text=True)
        fields = dict(line.split('=', 1) for line in raw.splitlines())
        if fields['ActiveState'] in ['inactive', 'failed'] and fields['MainPID'] == '0':
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Existing pilot publication did not finish; previous release retained.')
        time.sleep(1)
    # The previous publisher may have advanced the pointer while we waited.
    validate_current_publication()
    switched = True
    activate(release)
    systemctl('is-active', '--quiet', 'zecblock-pir-pilot.service')
    # Type=simple becomes active before Node opens its HTTP listener. Wait for
    # readiness under a finite deadline instead of treating that startup race
    # as a failed release. A persistent failure still rolls back below.
    ready_deadline = time.monotonic() + 15
    while True:
        try:
            with urllib.request.urlopen('http://127.0.0.1:4319/health', timeout=2) as response:
                if response.status == 200:
                    break
        except (OSError, URLError):
            pass
        if time.monotonic() >= ready_deadline:
            raise RuntimeError('Pilot readiness failed.')
        time.sleep(0.2)
except BaseException:
    if switched:
        activate(previous)
    raise
finally:
    if timer_active:
        systemctl('start', 'zecblock-pir-pilot-publish.timer')
print(json.dumps({'upgradedCommit': new_commit, 'previousReleaseRetained': previous_commit, 'restartedServices': ['zecblock-pir-pilot.service'], 'pilotTimerRestored': timer_active, 'existingProductionServicesChanged': False}))
