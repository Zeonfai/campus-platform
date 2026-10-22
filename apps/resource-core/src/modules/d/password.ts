import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, parameters, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

// Missing/disabled accounts pay the same password-computation cost.
export const dummyPasswordHash = `scrypt$131072$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  const salt = match?.[1];
  const digest = match?.[2];
  if (!salt || !digest) {
    await derive(password, Buffer.alloc(16));
    return false;
  }
  const actual = await derive(password, Buffer.from(salt, 'hex'));
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
