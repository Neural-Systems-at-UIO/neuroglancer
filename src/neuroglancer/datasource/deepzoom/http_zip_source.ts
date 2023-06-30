import { Url } from "src/neuroglancer/util/url";

export class NetzipHttpSource{
    public readonly zip_url: Url;
    private _size: number;

    private constructor(params: {zip_url: Url, size: number}){
      this.zip_url = params.zip_url
      this._size = params.size
    }

    public toJsonValue(){
      return {
        zip_url: this.zip_url.toJsonValue(),
        _size: this._size
      }
    }

    public static fromJsonValue(val: ReturnType<NetzipHttpSource["toJsonValue"]>): NetzipHttpSource{
      return new NetzipHttpSource({
        zip_url: Url.parse(val.zip_url),
        size: val._size
      })
    }

    public static async create(params: {zip_url: Url}): Promise<NetzipHttpSource | Error>{
      const result = await fetch(params.zip_url.raw, {
        method: "HEAD"
      })
      if(!result.ok){
        return new Error(`Could not retrieve size for ${params.zip_url.raw}`)
      }
      const raw_content_length = result.headers.get("Content-Length")
      if(raw_content_length === null){
        return new Error(`Response from ${params.zip_url.raw} had no (accessible) Content-Length header`)
      }
      const content_length = parseInt(raw_content_length)
      if(isNaN(content_length)){
        return new Error(`Response from ${params.zip_url.raw} had bad Content-Length header: ${raw_content_length}`)
      }
      return new NetzipHttpSource({zip_url: params.zip_url, size: content_length})
    }

    public async read(offset: number, size?: number): Promise<Uint8Array>{
      let range_header_value: string;
      if(offset >= 0){
          range_header_value = `bytes=${offset}-`
          if(size !== undefined){
              range_header_value += (offset + size - 1).toString()
          }
      }else{
          range_header_value = `bytes=${offset}`
      }

      const response = await fetch(this.zip_url.raw, {
        method: "GET",
        headers: new Headers({"Range": range_header_value}),
      })
      if(!response.ok){
          throw new Error(`Could not retrieve data from ${this.zip_url.raw}`)
      }
      const buffer = await response.arrayBuffer()
      return new Uint8Array(buffer)
    }

    public async size(): Promise<number>{
      return this._size
    }
  }

  function getUint64(
    view: DataView,
    byteOffset: number,
    littleEndian?: boolean,
  ): number {
    const lo = view.getUint32(byteOffset, littleEndian);
    const hi = view.getUint32(byteOffset + 4, littleEndian);
    if ((littleEndian && hi > 0x001fffff) || (!littleEndian && lo > 0x001fffff)) {
      throw new Error("64-bit integer too large");
    }
    return littleEndian ? lo + 0x100000000 * hi : hi + 0x100000000 * lo;
  }

  class Reader {
    private readonly data: Uint8Array;
    private readonly view: DataView;
    private readonly size: number;
    private localOffset: number;

    constructor(data: Uint8Array) {
      this.data = data;
      this.view = new DataView(data.buffer);
      this.size = data.byteLength;
      this.localOffset = 0;
    }

    private get globalOffset(): number {
      return this.data.byteOffset + this.localOffset;
    }

    read(size: number = -1): Uint8Array {
      const start = this.localOffset;
      const stop = size >= 0 ? start + size : this.size;
      if (stop > this.size) {
        throw new Error("out of bounds");
      }
      this.localOffset = stop;
      return this.data.subarray(start, stop);
    }

    move(delta: number): number {
      const newOffset = this.localOffset + delta;
      if (!(0 <= newOffset && newOffset < this.size)) {
        throw new Error("out of bounds");
      }
      this.localOffset = newOffset;
      return newOffset;
    }

    end(): boolean {
      return this.localOffset >= this.size;
    }

    match(expected: Uint8Array) {
      const newOffset = this.localOffset + expected.length;
      if (newOffset > this.size) {
        throw new Error("out of bounds");
      }
      if (!expected.every((v, i) => v == this.data[this.localOffset + i])) {
        throw new Error("match failed");
      }
      this.localOffset = newOffset;
    }

    number(size: 1 | 2 | 4 | 8): number {
      const newOffset = this.localOffset + size;
      if (newOffset > this.size) {
        throw new Error("out of bounds");
      }
      let value: number;
      if (size === 1) {
        value = this.data[this.globalOffset];
      } else if (size === 2) {
        value = this.view.getUint16(this.globalOffset, true);
      } else if (size === 4) {
        value = this.view.getUint32(this.globalOffset, true);
      } else if (size === 8) {
        value = getUint64(this.view, this.globalOffset, true);
      } else {
        throw new Error("invalid size");
      }
      this.localOffset = newOffset;
      return value;
    }

    numberMatch(size: 1 | 2 | 4 | 8, expected: number, msg: string): void {
      if (this.number(size) !== expected) {
        throw new Error(msg);
      }
    }
  }

  class Entry{
    public readonly name: string;
    public readonly offset: number;
    public readonly size: number;
    public readonly crc32: number;
    public readonly comment: Uint8Array;

    constructor(params: {
      name: string;
      offset: number;
      size: number;
      crc32: number;
      comment: Uint8Array;
    }){
      this.name = params.name;
      this.offset = params.offset;
      this.size = params.size;
      this.crc32 = params.crc32;
      this.comment = params.comment;
    }

    public toJsonValue(): {
      name: string,
      offset: number,
      size: number,
      crc32: number,
      comment: Array<number>,
    }{
      return {
        name: this.name,
        offset: this.offset,
        size: this.size,
        crc32: this.crc32,
        comment: Array.from(this.comment),
      }
    }

    public static fromJsonValue(obj: ReturnType<Entry["toJsonValue"]>): Entry{
      return new Entry({
        name: obj.name,
        offset: obj.offset,
        size: obj.size,
        crc32: obj.crc32,
        comment: new Uint8Array(obj.comment)
      })
    }
  }

  function rfind(data: Uint8Array, pattern: Uint8Array): number {
    for (let start = data.length - pattern.length; start >= 0; --start) {
      if (pattern.every((v, i) => v == data[start + i])) {
        return start;
      }
    }
    return -1;
  }

  const MULTIDISK_ERRMSG = "Multi-disk archives are not supported";
  const ENCRYPTED_ERRMSG = "Encrypted archives are not supported";
  const COMPRESSED_ERRMSG = "Compressed archives are not supported";

  class CRC32 {
    private static makeTable() {
      let table = new Uint32Array(256);
      for (let i = 0; i < 256; ++i) {
        let c = i;
        for (let k = 0; k < 8; ++k) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
      }
      return table;
    }

    private static readonly table = CRC32.makeTable();

    static of(data: Uint8Array): number {
      let crc = 0xffffffff;
      for (const b of data) {
        crc = CRC32.table[(crc ^ b) & 0xff] ^ (crc >>> 8);
      }
      // ">>> 0" converts to unsigned.
      return (crc ^ 0xffffffff) >>> 0;
    }
  }

  export class Archive {
    private constructor(
      public readonly source: NetzipHttpSource,
      public readonly entries: Map<string, Entry>,
      public readonly comment: Uint8Array
    ){}

    public toJsonValue(){
      let entries: Record<string, ReturnType<Entry["toJsonValue"]>> = {}
      for(let [name, entry] of this.entries.entries()){
        entries[name] = entry.toJsonValue()
      }
      return {
        source: this.source.toJsonValue(),
        entries,
        comment: Array.from(this.comment)
      }
    }

    public static fromJsonValue(val: ReturnType<Archive["toJsonValue"]>): Archive{
      let entries = new Map<string, Entry>();
      for(let key in val.entries){
        entries.set(key, Entry.fromJsonValue(val.entries[key]))
      }
      return new Archive(
        NetzipHttpSource.fromJsonValue(val.source),
        entries,
        new Uint8Array(val.comment),
      )
    }

    static async from(source: NetzipHttpSource): Promise<Archive> {
      const ssize = await source.size();
      const eocdBlock = await source.read(-65577);
      const eocdOffset = rfind(
        eocdBlock,
        new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
      );
      if (eocdOffset < 0) {
        throw new Error("Could not find end of central directory");
      }

      const eocd = new Reader(eocdBlock.subarray(eocdOffset));
      eocd.move(4);
      eocd.numberMatch(2, 0, MULTIDISK_ERRMSG);
      eocd.numberMatch(2, 0, MULTIDISK_ERRMSG);
      let entryCount = eocd.number(2);
      eocd.numberMatch(2, entryCount, MULTIDISK_ERRMSG);
      let cdsize = eocd.number(4);
      let cdoffset = eocd.number(4);
      const comment = eocd.read(eocd.number(2));
      if (!eocd.end()) {
        throw new Error("Unexpected data after end of central directory");
      }

      if (
        entryCount === 0xffff ||
        cdsize === 0xffffffff ||
        cdoffset === 0xffffffff
      ) {
        if (eocdOffset < 20) {
          throw new Error("ZIP64 end of central directory locator not found");
        }
        const loc = new Reader(eocdBlock.subarray(eocdOffset - 20, eocdOffset));
        loc.match(new Uint8Array([0x50, 0x4b, 0x06, 0x07]));
        loc.numberMatch(4, 0, MULTIDISK_ERRMSG);
        const eocd64Offset = loc.number(8);
        loc.numberMatch(4, 1, MULTIDISK_ERRMSG);

        const eocd64 = new Reader(await source.read(eocd64Offset, 56));
        eocd64.match(new Uint8Array([0x50, 0x4b, 0x06, 0x06]));
        eocd64.numberMatch(8, 44, "ZIP64 extensible data is not supported");
        eocd64.move(4);
        eocd64.numberMatch(4, 0, MULTIDISK_ERRMSG);
        eocd64.numberMatch(4, 0, MULTIDISK_ERRMSG);
        entryCount = eocd64.number(8);
        eocd64.numberMatch(8, entryCount, MULTIDISK_ERRMSG);
        cdsize = eocd64.number(8);
        cdoffset = eocd64.number(8);
      }

      if (cdoffset + cdsize > ssize) {
        throw new Error("Central directory is outside of the file");
      }
      const cd = new Reader(await source.read(cdoffset, cdsize));

      const entries = new Map<string, Entry>();
      for (let i = 0; i < entryCount; ++i) {
        cd.match(new Uint8Array([0x50, 0x4b, 0x01, 0x02]));
        cd.move(4);
        const flags = cd.number(2);
        if ((flags & 0x0001) != 0) {
          throw new Error(ENCRYPTED_ERRMSG);
        }
        if ((flags & 0x0008) != 0) {
          throw new Error("Data descriptor is not supported");
        }
        if ((flags & 0x0020) != 0) {
          throw new Error("Compressed patched data is not supported");
        }
        if ((flags & 0x0040) != 0) {
          throw new Error(ENCRYPTED_ERRMSG);
        }
        if ((flags & 0x0800) != 0) {
          throw new Error("UTF-8 is not supported");
        }
        if ((flags & 0x2000) != 0) {
          throw new Error(ENCRYPTED_ERRMSG);
        }
        cd.numberMatch(2, 0, COMPRESSED_ERRMSG);
        cd.move(4);
        const crc32 = cd.number(4);
        let fsize = cd.number(4);
        cd.numberMatch(4, fsize, COMPRESSED_ERRMSG);
        const fnamelen = cd.number(2);
        const extralen = cd.number(2);
        const fcommentlen = cd.number(2);
        cd.numberMatch(2, 0, MULTIDISK_ERRMSG);
        cd.move(6);
        let foffset = cd.number(4);
        const fname = String.fromCharCode(...cd.read(fnamelen));
        const extraBlock = cd.read(extralen);
        const fcomment = cd.read(fcommentlen);

        if (fsize === 0xffffffff || foffset === 0xffffffff) {
          const extra = new Reader(extraBlock);
          while (!extra.end()) {
            const extid = extra.number(2);
            const extsize = extra.number(2);
            if (extid === 0x0001) {
              if (![8, 16, 24, 28].includes(extsize)) {
                throw new Error("Invalid ZIP64 extra data size");
              }
              fsize = extra.number(8);
              if (extsize >= 16) {
                extra.numberMatch(8, fsize, COMPRESSED_ERRMSG);
              }
              if (extsize >= 24) {
                foffset = extra.number(8);
              }
              if (extsize >= 28) {
                extra.numberMatch(4, 0, MULTIDISK_ERRMSG);
              }
              break;
            } else {
              extra.move(extsize);
            }
          }
        }

        if (foffset + fsize > ssize) {
          throw new Error("File is outside of the archive");
        }
        if (entries.has(fname)) {
          throw new Error(`Duplicate file name ${fname}`);
        }
        entries.set(fname, new Entry({
          name: fname,
          offset: foffset,
          size: fsize,
          crc32,
          comment: fcomment,
        }));
      }

      if (!cd.end()) {
        throw new Error("Central directory has trailing data");
      }

      return new Archive(source, entries, comment);
    }

    public get size(): number {
      return this.entries.size;
    }

    [Symbol.iterator](): IterableIterator<string> {
      return this.entries.keys();
    }

    async get(name: string): Promise<Uint8Array> {
      const entry = this.entries.get(name);
      if (entry === undefined) {
        throw new Error(`File not found: ${name}`);
      }
      const data = new Reader(
        await this.source.read(entry.offset, entry.size + 65565),
      );
      data.match(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      data.move(24);
      data.move(entry.name.length + data.number(2));
      const payload = data.read(entry.size);

      if (CRC32.of(payload) !== entry.crc32) {
        throw new Error("CRC32 mismatch");
      }
      return payload;
    }
  }
