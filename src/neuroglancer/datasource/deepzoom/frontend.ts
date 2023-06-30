/**
 * @license
 * Copyright 2016 Google Inc., 2023 Gergely Csucs
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {BoundingBox, CoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, DataSubsourceEntry, GetDataSourceOptions, NormalizeUrlOptions} from 'neuroglancer/datasource';
import {ImageTileSourceParameters} from 'neuroglancer/datasource/deepzoom/base';
import {parseProviderUrl, unparseProviderUrl} from 'neuroglancer/datasource/precomputed/frontend';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import { Url } from 'src/neuroglancer/util/url';
import { DziAccessor, ZippedDziAccessor } from './dzi_accessor';

/*export*/ class DeepzoomImageTileSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), ImageTileSourceParameters)) {}

/*export*/ class DeepzoomPyramidalImageTileSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return DataType.UINT8;
  }

  get volumeType() {
    return VolumeType.IMAGE;
  }

  get rank() {
    return this.modelSpace.rank;
  }

  constructor(
      chunkManager: ChunkManager,
      public credentialsProvider: SpecialProtocolCredentialsProvider,
      public readonly accessor: DziAccessor | ZippedDziAccessor,
      public readonly modelSpace: CoordinateSpace,
      public readonly levelIndex?: number,
  ) {
    super(chunkManager);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    // const modelResolution = this.info.scales[0].resolution;
    const numChannels = 3 //FIXME: fetch this somehow
    const {rank} = this;
    const chunkSizes = [
      new Uint32Array([this.accessor.dziImageElement.tileSize, this.accessor.dziImageElement.tileSize, 1, numChannels])
    ]
    const levels = this.accessor.dziImageElement.levels.filter(lvl => this.levelIndex === undefined || lvl.levelIndex == this.levelIndex)
    return transposeNestedArrays(levels.map(scaleInfo => {
      // const {resolution} = scaleInfo;
      const stride = rank + 1;
      const chunkToMultiscaleTransform = new Float32Array(stride * stride);
      chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
      const {lowerBounds: baseLowerBound, upperBounds: baseUpperBound} =
          this.modelSpace.boundingBoxes[0].box;
      const lowerClipBound = new Float32Array(rank);
      const upperClipBound = new Float32Array(rank);
      const relativeScale = levels.length == 1 ? 1 : Math.pow(2, this.accessor.dziImageElement.maxLevelIndex - scaleInfo.levelIndex);
      for (let i = 0; i < 3; ++i) {
        chunkToMultiscaleTransform[stride * i + i] = relativeScale;
        const voxelOffsetValue = 0;
        chunkToMultiscaleTransform[stride * rank + i] = voxelOffsetValue * relativeScale;
        lowerClipBound[i] = baseLowerBound[i] / relativeScale - voxelOffsetValue;
        upperClipBound[i] = baseUpperBound[i] / relativeScale - voxelOffsetValue;
      }
      if (rank === 4) {
        chunkToMultiscaleTransform[stride * 3 + 3] = 1;
        lowerClipBound[3] = baseLowerBound[3];
        upperClipBound[3] = baseUpperBound[3];
      }
      return makeDefaultVolumeChunkSpecifications({
               rank,
               dataType: this.dataType,
               chunkToMultiscaleTransform,
               upperVoxelBound: new Float32Array([scaleInfo.width, scaleInfo.height, 1, numChannels]),//scaleInfo.size,
               volumeType: this.volumeType,
               chunkDataSizes: chunkSizes,
               baseVoxelOffset: new Float32Array([0,0,0,0]),
               volumeSourceOptions,
             })
          .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                 chunkSource: this.chunkManager.getChunkSource(DeepzoomImageTileSource, {
                   credentialsProvider: this.credentialsProvider,
                   spec,
                   parameters: {
                     rawAccessor: this.accessor.toJsonValue(),
                     levelIndex: scaleInfo.levelIndex,
                   }
                 }),
                 chunkToMultiscaleTransform,
                 lowerClipBound,
                 upperClipBound,
               }));
    }));
  }
}

async function getImageDataSource(
  options: GetDataSourceOptions,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: Url
): Promise<DataSource | Error> {
  let accessor: ZippedDziAccessor | DziAccessor;
  if(url.path.components.find(comp => comp.endsWith(".dzip"))){
    let accessor_result = await ZippedDziAccessor.create({url: url})
    if(accessor_result instanceof Error){ return accessor_result }
    accessor = accessor_result
  }else if(url.path.extension?.toLowerCase() == "dzi"){
    let accessor_result = await DziAccessor.create(url)
    if(accessor_result instanceof Error){ return accessor_result }
    accessor = accessor_result
  }else{
    return new Error(`Path does not seem to point to a dzi file: ${url}`)
  }

  let {width, height} = accessor.dziImageElement;
  let numChannels = 3 //FIXME

  let levelIndex: number | undefined = undefined;
  if(url.hash){
    const match = url.hash.match(/^level=(?<levelIndex>\d+\b)/);
    if(match){
      levelIndex = parseInt(match.groups!["levelIndex"])
      const level = accessor.dziImageElement.levels[levelIndex]
      width = level.width
      height = level.height
    }
  }

  let baseScale = {
    resolution: [1,1,1],
    voxelOffset: [0,0,0],
    size: [width, height, 1],
  }

  const rank = (numChannels === 1) ? 3 : 4;
  const scales = new Float64Array(rank);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const names = ['x', 'y', 'z'];
  const units = ['m', 'm', 'm'];

  for (let i = 0; i < 3; ++i) {
    scales[i] = baseScale.resolution[i] / 1e9;
    lowerBounds[i] = baseScale.voxelOffset[i];
    upperBounds[i] = lowerBounds[i] + baseScale.size[i];
  }
  if (rank === 4) {
    scales[3] = 1;
    upperBounds[3] = numChannels;
    names[3] = 'c^';
    units[3] = '';
  }
  const box: BoundingBox = {lowerBounds, upperBounds};
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const volume = new DeepzoomPyramidalImageTileSource(options.chunkManager, credentialsProvider, accessor, modelSpace, levelIndex);
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {volume},
    },
    {
      id: 'bounds',
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(modelSpace.bounds),
      },
    },
  ];
  return {modelTransform: makeIdentityTransform(modelSpace), subsources};
}

export class DeepzoomDataSource extends DataSourceProvider {
  get description() {
    return 'Deep Zoom file-backed data source';
  }

  normalizeUrl(options: NormalizeUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const {url: providerUrl, parameters} = parseProviderUrl(options.providerUrl);
    const parsedUrl = Url.parse(options.providerUrl)
    return options.chunkManager.memoize.getUncounted(
        {'type': 'deepzoom:get', providerUrl: options.providerUrl, parameters}, async(): Promise<DataSource> => {
          const {credentialsProvider} = parseSpecialUrl(providerUrl, options.credentialsManager);
          const datasourceResult = await getImageDataSource(options, credentialsProvider, parsedUrl);
          if(datasourceResult instanceof Error){
            throw datasourceResult
          }
          return datasourceResult
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}
