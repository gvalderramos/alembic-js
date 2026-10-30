/**
 * Reference implementation of the 'fnv1a64-faces-v1' topology hash (spec 0009). Browser-safe and
 * BigInt-free: the 64-bit state is kept as two unsigned 32-bit halves.
 *
 * Definition: FNV-1a 64-bit (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over every face
 * count, then every face index, each written as uint32 little-endian, in file order. The result is
 * 16 lowercase hex digits. Negative indices are hashed as their uint32 bit pattern.
 */

/** Name of the default topology hash, as reported in `AbcTopology.hashAlgorithm`. */
export const TOPOLOGY_HASH_ALGORITHM = 'fnv1a64-faces-v1';

const TWO_32 = 0x100000000;

/** Topology hash of raw face counts and face indices, as stored in an Alembic mesh sample. */
export function topologyHash(faceCounts: ArrayLike<number>, faceIndices: ArrayLike<number>): string {
    // FNV-1a 64 offset basis 0xcbf29ce484222325.
    let hi = 0xcbf29ce4;
    let lo = 0x84222325;
    const feed = (values: ArrayLike<number>) => {
        for (let i = 0; i < values.length; i++) {
            const value = values[i] >>> 0;
            for (let shift = 0; shift < 32; shift += 8) {
                lo = (lo ^ ((value >>> shift) & 0xff)) >>> 0;
                // state *= 0x100000001b3 (mod 2^64), i.e. state * 0x1b3 + (state << 40).
                // Every intermediate value stays below 2^53, so doubles are exact.
                const low = lo * 0x1b3;
                const newLo = low >>> 0;
                const carry = (low - newLo) / TWO_32;
                hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) >>> 0;
                lo = newLo;
            }
        }
    };
    feed(faceCounts);
    feed(faceIndices);
    return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
