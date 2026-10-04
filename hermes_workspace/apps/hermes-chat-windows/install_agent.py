#!/usr/bin/env python3
"""Install an extracted HermesWorkspace agent package into an isolated HERMES_HOME."""
import argparse
import json
import os
from pathlib import Path
import shutil
import time


def install(source: Path, target: Path, include_env=False):
    source, target = source.resolve(), target.resolve()
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('Source and target must be separate directories.')
    manifest = json.loads((source / 'agent.json').read_text(encoding='utf-8'))
    if manifest.get('Schema') != 1:
        raise ValueError('Unsupported agent package schema.')
    sources = [source / 'SOUL.md']
    skills = source / 'skills'
    if skills.is_dir():
        sources += [p for p in skills.rglob('*') if p.is_file()]
    if (source / '.env.example').exists():
        sources.append(source / '.env.example')
    if include_env and (source / '.env').exists():
        sources.append(source / '.env')
    # Validate the whole copy plan before creating any target files.
    plan = []
    for path in sources:
        if path.is_symlink() or source not in path.resolve().parents:
            raise ValueError(f'Symlink/out-of-package file rejected: {path.name}')
        relative = path.relative_to(source)
        dest = target / relative
        # Existing target symlinks must not redirect writes out of HERMES_HOME.
        for parent in [dest, *dest.parents]:
            if parent.is_symlink():
                raise ValueError(f'Target symlink rejected: {parent}')
            if parent == target:
                break
        plan.append((path, dest))
    backup = target / '.workspace-backups' / (str(time.time_ns()))
    for path, dest in plan:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            previous = backup / dest.relative_to(target)
            previous.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, previous)
        if path.name == '.env' and dest.exists():
            # Preserve existing values; add only missing variables from the package.
            existing = dest.read_text(encoding='utf-8')
            names = {line.split('=', 1)[0] for line in existing.splitlines() if '=' in line and not line.startswith('#')}
            additions = [line for line in path.read_text(encoding='utf-8').splitlines() if '=' in line and line.split('=', 1)[0] not in names]
            dest.write_text(existing.rstrip('\n') + '\n' + '\n'.join(additions) + '\n', encoding='utf-8')
        else:
            shutil.copy2(path, dest)
        if path.name == '.env' and os.name != 'nt':
            dest.chmod(0o600)
    return len(plan)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, type=Path, help='Isolated Hermes home directory')
    parser.add_argument('--include-env', action='store_true', help='Import real .env values when present')
    args = parser.parse_args()
    count = install(Path(__file__).parent, args.target, args.include_env)
    print(f'Installed {count} files into {args.target.resolve()}')
    print('Set HERMES_HOME to this directory before starting Hermes. No code was executed.')


if __name__ == '__main__':
    main()
