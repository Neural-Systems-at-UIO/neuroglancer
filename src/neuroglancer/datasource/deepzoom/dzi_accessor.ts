import { Url, Path } from "src/neuroglancer/util/url";
import { NetzipHttpSource, Archive } from "./http_zip_source";

function tryGetIntAttribute(element: Element, propertyName: string): number | Error{
    const rawAttr = element.getAttribute(propertyName)
    if(rawAttr === null){
        return new Error(`Could not find Width in dzi size information`)
    }
    const value = parseInt(rawAttr)
    if(isNaN(value)){
        return new Error(`Could not parse attribute named '${propertyName}' as int: ${rawAttr}`)
    }
    return value
}

export class DziScale{
    public readonly width: number;
    public readonly height: number;
    public readonly levelIndex: number;

    constructor(params: {width: number, height: number, levelIndex: number}){
        this.width = params.width
        this.height = params.height
        this.levelIndex = params.levelIndex
    }
}

export class DziImageElement{
    public readonly width: number
    public readonly height: number
    public readonly tileSize: number
    public readonly overlap: number
    public readonly format: "jpg" | "jpeg" | "png"
    public readonly levels: Array<DziScale>
    public readonly maxLevelIndex: number;

    public constructor(params: {
        width: number, height: number, tileSize: number, overlap: number, format: "jpg" | "jpeg" | "png"
    }){
        this.width = params.width
        this.height = params.height
        this.tileSize = params.tileSize
        this.overlap = params.overlap
        this.format = params.format
        this.maxLevelIndex = Math.ceil(Math.log2(Math.max(params.height, params.width)))


        this.levels = []
        let w = params.width, h = params.height;
        while (w > 1 || h > 1) {
            this.levels.unshift(new DziScale({
                width: w, height: h, levelIndex: this.maxLevelIndex - this.levels.length
            }));
            w = Math.ceil(w / 2);
            h = Math.ceil(h / 2);
        }
        this.levels.unshift(new DziScale({
            width: w, height: h, levelIndex: this.maxLevelIndex - this.levels.length
        }));

    }

    public toJsonValue(){
        return {
            width: this.width,
            height: this.height,
            tileSize: this.tileSize,
            overlap: this.overlap,
            format: this.format,
            levels: this.levels,
        }
    }

    public static fromJsonValue(val: ReturnType<DziImageElement["toJsonValue"]>): DziImageElement{
        return new DziImageElement(val)
    }

    public static tryParse(text: string | Uint8Array): DziImageElement | Error{
        if(typeof(text) != "string"){
            try{
                text = new TextDecoder().decode(text)
            }catch(e){
                return new Error(`Could not decode dzi xml bytes into string`)
            }
        }
        let xml: Document
        try{
            xml = new DOMParser().parseFromString(text, 'text/xml');
        }catch(e){
            return new Error(`Failed parsing dzi contents: ${e}`)
        }
        const imageElement = xml.documentElement;
        const sizeElement = imageElement.getElementsByTagName('Size').item(0);
        if(sizeElement === null){
            return new Error(`Could not retrieve Size elemenet from dzi xml`)
        }

        const width = tryGetIntAttribute(sizeElement, "Width")
        if(width instanceof Error){ return width }

        const height = tryGetIntAttribute(sizeElement, "Height")
        if(height instanceof Error){ return height }

        const tileSize = tryGetIntAttribute(imageElement, "TileSize")
        if(tileSize instanceof Error){ return tileSize }

        const overlap = tryGetIntAttribute(imageElement, "Overlap")
        if(overlap instanceof Error){ return overlap }

        const format = imageElement.getAttribute("Format")
        if(format != "jpg" && format != "jpeg" && format != "png"){
            return new Error(`Bad format in dzi: ${format}`)
        }

        return new DziImageElement({width, height, tileSize, overlap, format})
    }
}

export class DziAccessor{
    public readonly dziImageElement: DziImageElement;
    public readonly dziFilesDirUrl: Url;

    public constructor(params: {dziImageElement: DziImageElement, dziFilesDirUrl: Url}){
        this.dziImageElement = params.dziImageElement
        this.dziFilesDirUrl = params.dziFilesDirUrl
    }

    public toJsonValue(){
        return {
            dziImageElement: this.dziImageElement.toJsonValue(),
            dziFilesDirUrl: this.dziFilesDirUrl.toJsonValue(),
        }
    }

    public static fromJsonValue(raw: ReturnType<DziAccessor["toJsonValue"]>): DziAccessor{
        return new DziAccessor({
            dziImageElement: DziImageElement.fromJsonValue(raw.dziImageElement),
            dziFilesDirUrl: Url.parse(raw.dziFilesDirUrl)
        })
    }

    public async fetchTile({
        level, column, row, requestInit={}
    }: {level: number, column: number, row: number, requestInit?: RequestInit}): Promise<Uint8Array | Error>{
        const tileUrl = this.dziFilesDirUrl.joinPath(`${level}/${column}_${row}.${this.dziImageElement.format}`)
        const tileResponse = await fetch(tileUrl.raw, requestInit)
        if(!tileResponse.ok){
            return new Error(`Failed to retrieve tile at ${tileUrl}`)
        }
        const data = await tileResponse.arrayBuffer()
        const datauin8 = new Uint8Array(data)

        return datauin8
    }

    public static async create(url: Url): Promise<DziAccessor | Error>{
        if(!url.path.name.toLowerCase().endsWith(".dzi")){
            return new Error(`Bad dzi url: ${url.raw}`)
        }
        const dziResponse = await fetch(url.raw)
        if(!dziResponse.ok){
            return new Error(`Failed retrieveing dzi xml`)
        }
        const rawXml = await dziResponse.text()
        const dziImageElement = DziImageElement.tryParse(rawXml)
        if(dziImageElement instanceof Error){
            return dziImageElement
        }

        const filesDirName = url.path.name.slice(0, -4) + "_files"
        const dziFilesDirUrl = url.parent.joinPath(filesDirName)

        return new DziAccessor({dziImageElement, dziFilesDirUrl})
    }
}

export class ZippedDziAccessor{
    public readonly dziImageElement: DziImageElement;
    public readonly filesDirPath: Path;
    private readonly archive: Archive;

    public constructor(params: {
        dziImageElement: DziImageElement,
        filesDirPath: Path,
        archive: Archive,
    }){
        this.dziImageElement = params.dziImageElement
        this.filesDirPath = params.filesDirPath
        this.archive = params.archive
    }

    public toJsonValue(){
        return {
            dziImageElement: this.dziImageElement.toJsonValue(),
            filesDirPath: this.filesDirPath.raw,
            archive: this.archive.toJsonValue(),
        }
    }

    public static fromJsonValue(val: ReturnType<ZippedDziAccessor["toJsonValue"]>): ZippedDziAccessor{
        return new ZippedDziAccessor({
            dziImageElement: DziImageElement.fromJsonValue(val.dziImageElement),
            archive: Archive.fromJsonValue(val.archive),
            filesDirPath: Path.parse(val.filesDirPath),
        })
    }

    public async fetchTile(
        {level, column, row}: {level: number, column: number, row: number}
    ): Promise<Uint8Array | Error>{
        const tilePath = this.filesDirPath.joinPath(`${level}/${column}_${row}.${this.dziImageElement.format}`).raw.slice(1)
        try{
            return new Uint8Array(await this.archive.get(tilePath));
        }catch(e){
            return new Error(`Failed fetching tile ${tilePath}`)
        }
    }

    public static async create({url}: {url: Url}): Promise<ZippedDziAccessor | Error>{
        const root = new Path({components: []})
        let external_path = new Path({components: []})
        let i = 0;
        for(; i<url.path.components.length; i++){
            const component = url.path.components[i]
            external_path = external_path.joinPath(component)
            if(component.toLowerCase().endsWith(".dzip")){
                break
            }
        }
        const internal_path = new Path({components: url.path.components.slice(i)})

        if(external_path.equals(root)){
            return new Error(`Expected url path to have '.dzip' somewhere: ${url.raw}`)
        }
        if(!internal_path.equals(root) && !internal_path.name.toLowerCase().endsWith(".dzi")){
            return new Error(`Bad internal dzi path: ${url.raw}`)
        }
        const source = await NetzipHttpSource.create({zip_url: url.updatedWith({path: external_path})})
        if(source instanceof Error){
          return source
        }
        let zipArchive: Archive
        try{
            zipArchive = await Archive.from(source);
        }catch(e){
            return new Error(`Failed creating zip archive: ${e}`)
        }

        //FIXME: actually use internal path if provided
        let internalPathToXml: Path | undefined = undefined;
        let internalPathToFilesDir: Path | undefined = undefined;
        for(let entryName of zipArchive.entries.keys()){
          const entryPath = Path.parse(entryName)
          if(entryPath.components.length != 1){
            continue
          }
          const extension = entryPath.extension?.toLowerCase()
          if(extension === undefined){
            continue
          }
          if(extension != "dzi" && extension != "xml"){
            continue
          }
          internalPathToXml = entryPath
          internalPathToFilesDir = entryPath.parent.joinPath(
            entryName.slice(0, -4) + "_files"
          )
          break
        }
        if(internalPathToFilesDir === undefined || internalPathToXml === undefined){
          return new Error(`Could not find DZI files inside ${url}`)
        }

        const xmlEntryName = internalPathToXml.raw.slice(1);
        let rawDziXml: Uint8Array
        try{
            rawDziXml = await zipArchive.get(xmlEntryName)
        }catch(e){
            return new Error(`Could not retrieve raw xml from .dzip at ${xmlEntryName}`)
        }
        const dziImageElement = DziImageElement.tryParse(rawDziXml)
        if(dziImageElement instanceof Error){
            return dziImageElement
        }
        return new ZippedDziAccessor({
            dziImageElement, filesDirPath: internalPathToFilesDir, archive: zipArchive
        })
    }
}