import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants, copyFile, open, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/** Writes beside the target, flushes, then renames over it: readers see old or new, never half. */
export async function writeFileAtomic(
  target: string,
  contents: string | Uint8Array,
): Promise<void> {
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    // A string is written as UTF-8.
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

/** Renames within a volume; across volumes copies, checks the size, then deletes the source. */
export async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
    await copyFile(source, target, constants.COPYFILE_EXCL);
    const [from, to] = await Promise.all([stat(source), stat(target)]);
    if (from.size !== to.size) {
      await unlink(target);
      throw new Error('Copied file size does not match its source.', { cause: error });
    }
    await unlink(source);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Size in bytes, or undefined when the file does not exist. */
export async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
