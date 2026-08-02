import { Script } from "scripting"
import { HlsAESDecryptor, decryptAES128CBC, hlsSequenceIV, parseHlsHexIV } from "./services/hls-crypto"
import { parseHlsMediaPlaylist } from "./services/hls"

// NIST SP 800-38A F.2.1 CBC-AES128 解密向量（2 块，无 PKCS7 填充）。
// Key: 2b7e151628aed2a6abf7158809cf4f3c  IV: 000102030405060708090a0b0c0d0e0f
// Ciphertext: 7649abac8119b246cee98e9b12e9197d 5086cb9b507219ee95db113a917678b2
// Plaintext : 6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51
const KEY_HEX = "2b7e151628aed2a6abf7158809cf4f3c"
const IV_HEX = "000102030405060708090a0b0c0d0e0f"
const CT_HEX = "7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2"
const PT_HEX = "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51"

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

const checks: Array<[string, boolean]> = []

// 1. 核心 AES-CBC 解密（NIST 向量，不除填充）
{
  const plain = decryptAES128CBC(hexToBytes(CT_HEX), hexToBytes(KEY_HEX), hexToBytes(IV_HEX), false)
  checks.push(["NIST CBC-AES128 解密向量正确", bytesToHex(plain) === PT_HEX])
}

// 2. 类接口 decrypt 与 removePadding（最后字节为 3 → 去掉 3 字节）
{
  const decryptor = new HlsAESDecryptor()
  const buffer = new Uint8Array([0xaa, 0xbb, 0x03]).buffer
  const stripped = decryptor.removePadding(buffer)
  checks.push(["removePadding 按末字节去除", new Uint8Array(stripped).length === 0])
  const empty = decryptor.removePadding(new Uint8Array(0).buffer)
  checks.push(["removePadding 空输入不抛错", empty.byteLength === 0])
}

// 3. 非 16 倍数密文应抛错（防御）
{
  let threw = false
  try {
    decryptAES128CBC(new Uint8Array(15), hexToBytes(KEY_HEX), hexToBytes(IV_HEX), false)
  } catch {
    threw = true
  }
  checks.push(["非 16 倍数密文抛错", threw])
}

// 4. HLS 默认 IV：序号大端，前 12 字节为 0
{
  const iv = hlsSequenceIV(7)
  const hex = bytesToHex(iv)
  checks.push(["hlsSequenceIV(7) 前 12 字节为 0 且末 4 字节为 0x00000007", hex === "00000000000000000000000000000007"])
}

// 5. parseHlsHexIV：0x 前缀 / 纯 hex / 非法
{
  const a = parseHlsHexIV("0x000102030405060708090a0b0c0d0e0f")
  checks.push(["parseHlsHexIV 支持 0x 前缀", a ? bytesToHex(a) === "000102030405060708090a0b0c0d0e0f" : false])
  const b = parseHlsHexIV("000102030405060708090a0b0c0d0e0f")
  checks.push(["parseHlsHexIV 支持纯 hex", b ? bytesToHex(b) === "000102030405060708090a0b0c0d0e0f" : false])
  checks.push(["parseHlsHexIV 非法输入返回 undefined", parseHlsHexIV("0x12") === undefined && parseHlsHexIV("") === undefined])
}

// 6. parseHlsMediaPlaylist：AES-128 + 相对 KEY URI + 显式 IV + MEDIA-SEQUENCE
{
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:266
#EXT-X-KEY:METHOD=AES-128,URI="key/enc.key",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:2.0,
https://cdn.example/video/seg-001.ts
#EXTINF:2.0,
https://cdn.example/video/seg-002.ts
#EXT-X-ENDLIST`, "https://cdn.example/video/playlist.m3u8")
  checks.push(["解析 AES-128 加密清单", plan.method === "aes-128"])
  checks.push(["KEY URI 相对路径绝对化", plan.keyURI === "https://cdn.example/video/key/enc.key"])
  checks.push(["IV 十六进制解析", plan.keyIV ? bytesToHex(plan.keyIV) === "000102030405060708090a0b0c0d0e0f" : false])
  checks.push(["MEDIA-SEQUENCE 基线", plan.mediaSequence === 266])
  checks.push(["分片 URL 解析", plan.segments.length === 2 && plan.segments[1].url === "https://cdn.example/video/seg-002.ts"])
}

// 7. parseHlsMediaPlaylist：METHOD=NONE 不算加密
{
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=NONE
#EXTINF:2,
seg-001.ts
#EXT-X-ENDLIST`, "https://cdn.example/video/playlist.m3u8")
  checks.push(["METHOD=NONE 不视为加密", plan.method === "none"])
  checks.push(["相对分片绝对化", plan.segments[0].url === "https://cdn.example/video/seg-001.ts"])
}

// 8. parseHlsMediaPlaylist：EXT-X-MAP（fMP4/CMAF）与缺省 IV
{
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="enc.key"
#EXTINF:2,
seg-001.m4s
#EXT-X-ENDLIST`, "https://cdn.example/video/playlist.m3u8")
  checks.push(["EXT-X-MAP 识别为 fMP4", plan.isMP4 && plan.initURI === "https://cdn.example/video/init.mp4"])
  checks.push(["未指定 IV 时为 undefined（用序号 IV）", plan.keyIV === undefined])
  checks.push(["缺省 IV 由 hlsSequenceIV 按序号生成", bytesToHex(hlsSequenceIV(266 + 0)).endsWith("0000010a")])
}

// 9. parseHlsMediaPlaylist：SAMPLE-AES 等其它 METHOD 标记 unsupported
{
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"
#EXTINF:2,
seg.ts
#EXT-X-ENDLIST`, "https://cdn.example/playlist.m3u8")
  checks.push(["SAMPLE-AES 标记 unsupported", plan.method === "unsupported"])
}

// 10. parseHlsMediaPlaylist：非法 IV 返回 undefined，KEY 缺失 URI 不崩溃
{
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,IV=0x12
#EXTINF:2,
seg.ts
#EXT-X-ENDLIST`, "https://cdn.example/playlist.m3u8")
  checks.push(["非法 IV 不崩溃且 keyIV 为 undefined", plan.method === "aes-128" && plan.keyIV === undefined && plan.keyURI === undefined])
}

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`HLS crypto checks failed: ${failed.join(", ")}`)
console.log(`HLS crypto checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
