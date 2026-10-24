# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Count owner-copy observation and remedy candidates across every tracked UTF-8 file.
# ABOUTME: Preserve line locations and hashes without copying private historical record text.
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

patterns = {
    'O1_explicit_sql': r'SELECT [^;]*last_(?:ok|call)_at[^;]*FROM (?:record_peers|referee_copies)',
    'O1_observation': r'last_(?:ok|call)_at',
    'R1_remedy': r"set[- ]aside|setting it aside|set it aside|sharing page|owner's page|project's page|on the dashboard|confirms? recovery",
}
regexes = {key: re.compile(value, re.I) for key, value in patterns.items()}
results = {key: {'count': 0, 'scopes': {}, 'matches': []} for key in patterns}
files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
inspected = 0
for file in filter(None, files):
    try:
        text = pathlib.Path(file).read_bytes().decode('utf8')
    except (OSError, UnicodeError):
        continue
    if '\0' in text:
        continue
    inspected += 1
    for lineno, line in enumerate(text.split('\n'), 1):
        for name, predicate in regexes.items():
            if not predicate.search(line):
                continue
            result = results[name]
            scope = file.split('/')[0]
            result['count'] += 1
            result['scopes'][scope] = result['scopes'].get(scope, 0) + 1
            result['matches'].append({
                'file': file,
                'line': lineno,
                'lineSha256': hashlib.sha256(line.encode()).hexdigest(),
            })
print(json.dumps({
    'measuredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'predicate': 'git ls-files -z; every extension; valid UTF-8 without NUL; one matching physical line per predicate, not occurrences',
    'patterns': patterns,
    'inspected': inspected,
    'results': results,
}, indent=2))
