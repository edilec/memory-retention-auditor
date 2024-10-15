import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DestinationError, assertWritableDestination } from '../src/index.mjs'
import { CLI, TODAY, clean, cliRun, withRoot } from './support.mjs'

/**
 * `--out` is the only path this tool writes to, and it is not a safe place to
 * put an unchecked path.
 *
 * Measured across this catalog rather than imagined: ten tools accepted a
 * destination that overwrote something they were never asked to touch, and four
 * of them exited 0 saying the write succeeded. The three holes are independent
 * and each needs its own case, because guarding one or two is what every one of
 * those tools had already done:
 *
 * 1. A **symlink at the destination** -- `realpath` resolves it, and resolving
 *    is the dangerous act, so it is refused on sight by `lstat`.
 * 2. A **symlinked parent** -- a lexical prefix check passes for
 *    `root/link/out`, so the parent is resolved and then compared.
 * 3. A **hard link to an input** -- no target and no shared path, so only
 *    device plus inode sees that it is the same file. For this tool the inputs
 *    are a memory inventory and the evidence that records were destroyed: a
 *    plan written over either of them destroys the thing the plan is about.
 *
 * The allowed cases matter just as much: a guard that refuses everything passes
 * every data-loss test above while making the tool useless, and a guard that
 * refuses every symlinked ancestor refuses every run under the macOS temp
 * directory, where `/var` is itself a link to `/private/var`.
 */

async function withTree(body) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-retention-auditor-out-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const run = (root, out, outRoot) => cliRun(['--root', root, '--today', TODAY, '--json', '--out', out, '--out-root', outRoot])

test('hole 1: a symbolic link at the destination is refused, and what it points at is untouched', async () => {
  await withTree(async (outRoot) => {
    const victim = join(outRoot, 'precious.json')
    await writeFile(victim, 'do not overwrite me')
    await symlink(victim, join(outRoot, 'plan.json'))

    await withRoot(clean(), async (root) => {
      const result = await run(root, join(outRoot, 'plan.json'), outRoot)

      assert.equal(result.code, 2)
      assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout is empty')
      assert.match(result.stderr, /symbolic link/)
      assert.equal(await readFile(victim, 'utf8'), 'do not overwrite me')
    })
  })
})

test('hole 1: a symbolic link to a path that does not exist yet is refused before it creates one', async () => {
  await withTree(async (outRoot) => {
    await withTree(async (elsewhere) => {
      const target = join(elsewhere, 'not-yet.json')
      await symlink(target, join(outRoot, 'plan.json'))

      await withRoot(clean(), async (root) => {
        const result = await run(root, join(outRoot, 'plan.json'), outRoot)

        assert.equal(result.code, 2)
        assert.equal(result.stdout, '')
        await assert.rejects(() => stat(target), 'nothing was created outside the tree')
      })
    })
  })
})

test('hole 2: a symlinked parent directory that leaves --out-root is refused', async () => {
  await withTree(async (outRoot) => {
    await withTree(async (elsewhere) => {
      await symlink(elsewhere, join(outRoot, 'escape'))

      await withRoot(clean(), async (root) => {
        const result = await run(root, join(outRoot, 'escape/plan.json'), outRoot)

        assert.equal(result.code, 2)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /outside the permitted root/)
        await assert.rejects(() => stat(join(elsewhere, 'plan.json')), 'nothing was written through the link')
      })
    })
  })
})

test('hole 2, the other direction: a symlinked parent that stays inside --out-root is allowed', async () => {
  await withTree(async (outRoot) => {
    await mkdir(join(outRoot, 'real'))
    await symlink(join(outRoot, 'real'), join(outRoot, 'linked'))

    await withRoot(clean(), async (root) => {
      const result = await run(root, join(outRoot, 'linked/plan.json'), outRoot)

      assert.equal(result.code, 0)
      assert.equal(JSON.parse(await readFile(join(outRoot, 'real/plan.json'), 'utf8')).tool, 'memory-retention-auditor')
    })
  })
})

test('hole 3: a hard link to any of the four inputs is refused, not just the primary one', async () => {
  // A sibling tool passed only its primary input to the guard and destroyed
  // every other file it read. Here the other files are the evidence that
  // records were destroyed and the holds that stop them being destroyed.
  for (const name of ['evidence.json', 'holds.json', 'policy.json', 'records.json']) {
    await withTree(async (outRoot) => {
      await withRoot(clean(), async (root) => {
        const input = join(root, name)
        const before = await readFile(input, 'utf8')
        await link(input, join(outRoot, 'plan.json'))

        const result = await run(root, join(outRoot, 'plan.json'), outRoot)

        assert.equal(result.code, 2, `${name} is refused as a destination`)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /same file as an input/)
        assert.equal(await readFile(input, 'utf8'), before, `${name} is byte-for-byte what it was`)
      })
    })
  }
})

test('the allowed case: a new file is written, and it carries the versioned plan', async () => {
  await withTree(async (outRoot) => {
    await withRoot(clean(), async (root) => {
      const out = join(outRoot, 'plan.json')
      const result = await run(root, out, outRoot)

      assert.equal(result.code, 0)
      const written = JSON.parse(await readFile(out, 'utf8'))
      assert.equal(written.tool, 'memory-retention-auditor')
      assert.equal(written.version, '2026-09-1')
      assert.equal(written.evaluatedOn, TODAY)
      assert.equal(typeof written.digest, 'string')
      assert.deepEqual(written.deletions, [])
      assert.equal(written.rows.length, 1)
      // The report still goes to stdout: --out adds an artefact, it does not
      // move the report off the stream a consumer pipes.
      assert.equal(JSON.parse(result.stdout).plan.digest, written.digest)
    })
  })
})

test('the allowed case: an existing ordinary file that is not an input is overwritten', async () => {
  await withTree(async (outRoot) => {
    const out = join(outRoot, 'plan.json')
    await writeFile(out, 'stale plan from the last run')

    await withRoot(clean(), async (root) => {
      const result = await run(root, out, outRoot)

      assert.equal(result.code, 0)
      assert.equal(JSON.parse(await readFile(out, 'utf8')).tool, 'memory-retention-auditor')
    })
  })
})

test('a destination that is a directory, or whose parent does not exist, is refused', async () => {
  await withTree(async (outRoot) => {
    await mkdir(join(outRoot, 'folder'))
    await withRoot(clean(), async (root) => {
      const directoryRun = await run(root, join(outRoot, 'folder'), outRoot)
      assert.equal(directoryRun.code, 2)
      assert.match(directoryRun.stderr, /not a regular file/)

      const missingRun = await run(root, join(outRoot, 'nowhere/plan.json'), outRoot)
      assert.equal(missingRun.code, 2)
      assert.match(missingRun.stderr, /does not exist/)
    })
  })
})

test('the destination is checked before the inputs are read, so a refusal writes nothing at all', async () => {
  await withTree(async (outRoot) => {
    await symlink(join(outRoot, 'victim.json'), join(outRoot, 'plan.json'))
    await writeFile(join(outRoot, 'victim.json'), 'kept')

    await withRoot({
      'records.json': '{', 'policy.json': '{', 'holds.json': '{', 'evidence.json': '{',
    }, async (root) => {
      const result = await run(root, join(outRoot, 'plan.json'), outRoot)

      assert.equal(result.code, 2)
      assert.equal(result.stdout, '')
      assert.equal(await readFile(join(outRoot, 'victim.json'), 'utf8'), 'kept')
    })
  })
})

test('--out-root without --out is a usage error rather than an ignored flag', async () => {
  await withRoot(clean(), async (root) => {
    const result = await cliRun(['--root', root, '--today', TODAY, '--json', '--out-root', root])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--out-root has no meaning without --out/)
  })
})

test('the guard is exported and refuses each hole on its own, so a caller can reuse it', async () => {
  await withTree(async (directory) => {
    const input = join(directory, 'input.json')
    await writeFile(input, '{}')

    await symlink(input, join(directory, 'linked.json'))
    await assert.rejects(
      () => assertWritableDestination(join(directory, 'linked.json'), { inputs: [input], root: directory }),
      DestinationError,
    )

    await link(input, join(directory, 'hard.json'))
    await assert.rejects(
      () => assertWritableDestination(join(directory, 'hard.json'), { inputs: [input], root: directory }),
      DestinationError,
    )

    const allowed = await assertWritableDestination(join(directory, 'fresh.json'), { inputs: [input], root: directory })
    assert.equal(allowed, join(directory, 'fresh.json'))
  })
})

test('the binary is the only place that writes, and it writes through one call', async () => {
  const source = await readFile(CLI, 'utf8')

  const writes = source.match(/[\w$.]*\.write\s*\(/g) ?? []
  assert.equal(writes.length > 0, true)
  for (const call of writes) {
    assert.equal(['process.stdout.write(', 'process.stderr.write('].includes(call.replace(/\s+/g, '')), true, call)
  }
  const fileWrites = source.match(/\bwriteFile\s*\(/g) ?? []
  assert.equal(fileWrites.length, 1, 'exactly one file write, and it is the guarded destination')
  assert.match(source, /await writeFile\(destination,/)
})
