// HLS AES-128 解密模块：纯 JS 查表法 AES-CBC。
// 移植自 hls.js 的 AESDecryptor（cat-catch 的 lib/m3u8-decrypt.js 同源，GPL/MIT 双许可来源）。
// 不依赖 WebCrypto / CryptoJS，可在 Scripting 模拟 Node 运行时直接运行；
// 用于 HLS #EXT-X-KEY:METHOD=AES-128 分片的原生解密下载。

/**
 * AES-CBC 解密器（AES-128/192/256 均可扩展，HLS 只用 128）。
 * 查表法：initTable 生成 S-box/逆 S-box/subMix/invSubMix 表，expandKey 做密钥扩展，
 * decrypt 逐 16 字节 CBC 解密并可选去除 PKCS7 填充。
 */
export class HlsAESDecryptor {
  private rcon: number[] = [0x0, 0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]
  private subMix: Uint32Array[] = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  private invSubMix: Uint32Array[] = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  private sBox = new Uint32Array(256)
  private invSBox = new Uint32Array(256)
  private key = new Uint32Array(0)
  private ksRows = 0
  private keySize = 0
  private keySchedule: Uint32Array = new Uint32Array(0)
  private invKeySchedule: Uint32Array = new Uint32Array(0)

  constructor() {
    this.initTable()
  }

  removePadding(array: ArrayBuffer): ArrayBuffer {
    const outputBytes = array.byteLength
    if (!outputBytes) return array
    const paddingBytes = new DataView(array).getUint8(outputBytes - 1)
    if (paddingBytes) {
      return array.slice(0, outputBytes - paddingBytes)
    }
    return array
  }

  // Using view.getUint32() also swaps the byte order.
  private uint8ArrayToUint32Array_(arrayBuffer: ArrayBuffer): Uint32Array {
    const view = new DataView(arrayBuffer)
    const newArray = new Uint32Array(4)
    for (let i = 0; i < 4; i += 1) {
      newArray[i] = view.getUint32(i * 4)
    }
    return newArray
  }

  private initTable(): void {
    const sBox = this.sBox
    const invSBox = this.invSBox
    const subMix = this.subMix
    const subMix0 = subMix[0]
    const subMix1 = subMix[1]
    const subMix2 = subMix[2]
    const subMix3 = subMix[3]
    const invSubMix = this.invSubMix
    const invSubMix0 = invSubMix[0]
    const invSubMix1 = invSubMix[1]
    const invSubMix2 = invSubMix[2]
    const invSubMix3 = invSubMix[3]
    const d = new Uint32Array(256)
    let x = 0
    let xi = 0
    let i = 0
    for (i = 0; i < 256; i += 1) {
      if (i < 128) {
        d[i] = i << 1
      } else {
        d[i] = (i << 1) ^ 0x11b
      }
    }
    for (i = 0; i < 256; i += 1) {
      let sx = xi ^ (xi << 1) ^ (xi << 2) ^ (xi << 3) ^ (xi << 4)
      sx = (sx >>> 8) ^ (sx & 0xff) ^ 0x63
      sBox[x] = sx
      invSBox[sx] = x
      // Compute multiplication
      const x2 = d[x]
      const x4 = d[x2]
      const x8 = d[x4]
      // Compute sub/invSub bytes, mix columns tables
      let t = (d[sx] * 0x101) ^ (sx * 0x1010100)
      subMix0[x] = (t << 24) | (t >>> 8)
      subMix1[x] = (t << 16) | (t >>> 16)
      subMix2[x] = (t << 8) | (t >>> 24)
      subMix3[x] = t
      // Compute inv sub bytes, inv mix columns tables
      t = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100)
      invSubMix0[sx] = (t << 24) | (t >>> 8)
      invSubMix1[sx] = (t << 16) | (t >>> 16)
      invSubMix2[sx] = (t << 8) | (t >>> 24)
      invSubMix3[sx] = t
      // Compute next counter
      if (!x) {
        x = xi = 1
      } else {
        x = x2 ^ d[d[d[x8 ^ x2]]]
        xi ^= d[d[xi]]
      }
    }
  }

  expandKey(keyBuffer: ArrayBuffer): void {
    // convert keyBuffer to Uint32Array
    const key = this.uint8ArrayToUint32Array_(keyBuffer)
    let sameKey = true
    let offset = 0
    while (offset < key.length && sameKey) {
      sameKey = key[offset] === this.key[offset]
      offset += 1
    }
    if (sameKey) {
      return
    }
    this.key = key
    const keySize = (this.keySize = key.length)
    if (keySize !== 4 && keySize !== 6 && keySize !== 8) {
      throw new Error("Invalid aes key size=" + keySize)
    }
    const ksRows = (this.ksRows = (keySize + 6 + 1) * 4)
    let ksRow: number
    let invKsRow: number
    const keySchedule = (this.keySchedule = new Uint32Array(ksRows))
    const invKeySchedule = (this.invKeySchedule = new Uint32Array(ksRows))
    const sbox = this.sBox
    const rcon = this.rcon
    const invSubMix = this.invSubMix
    const invSubMix0 = invSubMix[0]
    const invSubMix1 = invSubMix[1]
    const invSubMix2 = invSubMix[2]
    const invSubMix3 = invSubMix[3]
    let prev = 0
    let t = 0
    for (ksRow = 0; ksRow < ksRows; ksRow += 1) {
      if (ksRow < keySize) {
        prev = keySchedule[ksRow] = key[ksRow]
        continue
      }
      t = prev
      if (ksRow % keySize === 0) {
        // Rot word
        t = (t << 8) | (t >>> 24)
        // Sub word
        t =
          (sbox[t >>> 24] << 24) |
          (sbox[(t >>> 16) & 0xff] << 16) |
          (sbox[(t >>> 8) & 0xff] << 8) |
          sbox[t & 0xff]
        // Mix Rcon
        t ^= rcon[(ksRow / keySize) | 0] << 24
      } else if (keySize > 6 && ksRow % keySize === 4) {
        // Sub word
        t =
          (sbox[t >>> 24] << 24) |
          (sbox[(t >>> 16) & 0xff] << 16) |
          (sbox[(t >>> 8) & 0xff] << 8) |
          sbox[t & 0xff]
      }
      keySchedule[ksRow] = prev = (keySchedule[ksRow - keySize] ^ t) >>> 0
    }
    for (invKsRow = 0; invKsRow < ksRows; invKsRow += 1) {
      ksRow = ksRows - invKsRow
      if (invKsRow & 3) {
        t = keySchedule[ksRow]
      } else {
        t = keySchedule[ksRow - 4]
      }
      if (invKsRow < 4 || ksRow <= 4) {
        invKeySchedule[invKsRow] = t
      } else {
        invKeySchedule[invKsRow] =
          invSubMix0[sbox[t >>> 24]] ^
          invSubMix1[sbox[(t >>> 16) & 0xff]] ^
          invSubMix2[sbox[(t >>> 8) & 0xff]] ^
          invSubMix3[sbox[t & 0xff]]
      }
      invKeySchedule[invKsRow] = invKeySchedule[invKsRow] >>> 0
    }
  }

  // Adding this as a method greatly improves performance.
  private networkToHostOrderSwap(word: number): number {
    return (
      (word << 24) |
      ((word & 0xff00) << 8) |
      ((word & 0xff0000) >> 8) |
      (word >>> 24)
    )
  }

  /**
   * 解密一个 AES-CBC 密文块。
   * @param inputArrayBuffer 密文（长度须为 16 的倍数；offset 之后剩余须为 4 的倍数）
   * @param offset 起始 uint32 字偏移（与 hls.js 一致）
   * @param aesIV 16 字节初始向量
   * @param removePKCS7Padding 是否去除 PKCS7 填充（HLS 分片应传 true）
   */
  decrypt(inputArrayBuffer: ArrayBuffer, offset: number, aesIV: ArrayBuffer, removePKCS7Padding: boolean): ArrayBuffer {
    if (inputArrayBuffer.byteLength % 16 !== 0) {
      throw new Error(`AES-CBC 密文长度须为 16 的倍数（实际 ${inputArrayBuffer.byteLength}）`)
    }
    const nRounds = this.keySize + 6
    const invKeySchedule = this.invKeySchedule
    const invSBOX = this.invSBox
    const invSubMix = this.invSubMix
    const invSubMix0 = invSubMix[0]
    const invSubMix1 = invSubMix[1]
    const invSubMix2 = invSubMix[2]
    const invSubMix3 = invSubMix[3]
    const initVector = this.uint8ArrayToUint32Array_(aesIV)
    let initVector0 = initVector[0]
    let initVector1 = initVector[1]
    let initVector2 = initVector[2]
    let initVector3 = initVector[3]
    const inputInt32 = new Int32Array(inputArrayBuffer)
    const outputInt32 = new Int32Array(inputInt32.length)
    let t0 = 0
    let t1 = 0
    let t2 = 0
    let t3 = 0
    let s0 = 0
    let s1 = 0
    let s2 = 0
    let s3 = 0
    let inputWords0 = 0
    let inputWords1 = 0
    let inputWords2 = 0
    let inputWords3 = 0
    let ksRow = 0
    let i = 0
    const swapWord = (word: number) => this.networkToHostOrderSwap(word)
    while (offset < inputInt32.length) {
      inputWords0 = swapWord(inputInt32[offset])
      inputWords1 = swapWord(inputInt32[offset + 1])
      inputWords2 = swapWord(inputInt32[offset + 2])
      inputWords3 = swapWord(inputInt32[offset + 3])
      s0 = inputWords0 ^ invKeySchedule[0]
      s1 = inputWords3 ^ invKeySchedule[1]
      s2 = inputWords2 ^ invKeySchedule[2]
      s3 = inputWords1 ^ invKeySchedule[3]
      ksRow = 4
      // Iterate through the rounds of decryption
      for (i = 1; i < nRounds; i += 1) {
        t0 =
          invSubMix0[s0 >>> 24] ^
          invSubMix1[(s1 >> 16) & 0xff] ^
          invSubMix2[(s2 >> 8) & 0xff] ^
          invSubMix3[s3 & 0xff] ^
          invKeySchedule[ksRow]
        t1 =
          invSubMix0[s1 >>> 24] ^
          invSubMix1[(s2 >> 16) & 0xff] ^
          invSubMix2[(s3 >> 8) & 0xff] ^
          invSubMix3[s0 & 0xff] ^
          invKeySchedule[ksRow + 1]
        t2 =
          invSubMix0[s2 >>> 24] ^
          invSubMix1[(s3 >> 16) & 0xff] ^
          invSubMix2[(s0 >> 8) & 0xff] ^
          invSubMix3[s1 & 0xff] ^
          invKeySchedule[ksRow + 2]
        t3 =
          invSubMix0[s3 >>> 24] ^
          invSubMix1[(s0 >> 16) & 0xff] ^
          invSubMix2[(s1 >> 8) & 0xff] ^
          invSubMix3[s2 & 0xff] ^
          invKeySchedule[ksRow + 3]
        // Update state
        s0 = t0
        s1 = t1
        s2 = t2
        s3 = t3
        ksRow = ksRow + 4
      }
      // Shift rows, sub bytes, add round key
      t0 =
        (invSBOX[s0 >>> 24] << 24) ^
        (invSBOX[(s1 >> 16) & 0xff] << 16) ^
        (invSBOX[(s2 >> 8) & 0xff] << 8) ^
        invSBOX[s3 & 0xff] ^
        invKeySchedule[ksRow]
      t1 =
        (invSBOX[s1 >>> 24] << 24) ^
        (invSBOX[(s2 >> 16) & 0xff] << 16) ^
        (invSBOX[(s3 >> 8) & 0xff] << 8) ^
        invSBOX[s0 & 0xff] ^
        invKeySchedule[ksRow + 1]
      t2 =
        (invSBOX[s2 >>> 24] << 24) ^
        (invSBOX[(s3 >> 16) & 0xff] << 16) ^
        (invSBOX[(s0 >> 8) & 0xff] << 8) ^
        invSBOX[s1 & 0xff] ^
        invKeySchedule[ksRow + 2]
      t3 =
        (invSBOX[s3 >>> 24] << 24) ^
        (invSBOX[(s0 >> 16) & 0xff] << 16) ^
        (invSBOX[(s1 >> 8) & 0xff] << 8) ^
        invSBOX[s2 & 0xff] ^
        invKeySchedule[ksRow + 3]
      // Write
      outputInt32[offset] = swapWord(t0 ^ initVector0)
      outputInt32[offset + 1] = swapWord(t3 ^ initVector1)
      outputInt32[offset + 2] = swapWord(t2 ^ initVector2)
      outputInt32[offset + 3] = swapWord(t1 ^ initVector3)
      // reset initVector to last 4 unsigned int
      initVector0 = inputWords0
      initVector1 = inputWords1
      initVector2 = inputWords2
      initVector3 = inputWords3
      offset = offset + 4
    }
    return removePKCS7Padding ? this.removePadding(outputInt32.buffer) : outputInt32.buffer
  }
}

/** 拷贝 Uint8Array 到独立 ArrayBuffer（处理 byteOffset 与共享 buffer）。 */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/** 拷贝 16 字节数组为 ArrayBuffer（KEY / IV）。 */
function copy16ToArrayBuffer(bytes: Uint8Array, label: string): ArrayBuffer {
  if (bytes.byteLength !== 16) throw new Error(`${label} 须为 16 字节（实际 ${bytes.byteLength}）`)
  return copyToArrayBuffer(bytes)
}

/**
 * 解密一段 HLS AES-128 分片。
 * @param data 加密分片密文
 * @param key 16 字节 AES-128 密钥
 * @param iv 16 字节初始向量
 * @param removePKCS7Padding 是否去除 PKCS7 填充（默认 true）
 */
export function decryptAES128CBC(data: Uint8Array, key: Uint8Array, iv: Uint8Array, removePKCS7Padding = true): Uint8Array {
  const decryptor = new HlsAESDecryptor()
  decryptor.expandKey(copy16ToArrayBuffer(key, "AES-128 KEY"))
  const plain = decryptor.decrypt(copyToArrayBuffer(data), 0, copy16ToArrayBuffer(iv, "AES-128 IV"), removePKCS7Padding)
  return new Uint8Array(plain)
}

/**
 * HLS 默认 IV：16 字节大端序号（前 12 字节为 0，后 4 字节为分片序号）。
 * 规范：#EXT-X-KEY 未指定 IV 时，用分片在媒体清单中的序号（含 EXT-X-MEDIA-SEQUENCE 基线）。
 */
export function hlsSequenceIV(sequenceNumber: number): Uint8Array {
  const iv = new Uint8Array(16)
  new DataView(iv.buffer).setUint32(12, sequenceNumber >>> 0)
  return iv
}

/** 解析清单 IV 属性（"0x..." 32 位十六进制或纯 32 位十六进制）；非法返回 undefined。 */
export function parseHlsHexIV(value: string): Uint8Array | undefined {
  const hex = String(value || "").replace(/^0x/i, "").trim()
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
