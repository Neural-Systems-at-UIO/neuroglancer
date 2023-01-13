/**
 * @license
 * Copyright 2016 Google Inc.
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

/**
 * @file Main entry point for default neuroglancer viewer.
 */

import "neuroglancer/util/fetch_wrapper"; //handles fetch requests to data-proxy buckets

import {setupDefaultViewer} from 'neuroglancer/ui/default_viewer_setup';
import {ILASTIK_URL} from 'neuroglancer/ilastik_api_url';
import { Url } from './neuroglancer/util/url';

window.addEventListener('DOMContentLoaded', () => {
  setupDefaultViewer({
    showLayerDialog: false,
    showHelpButton: false,
    showEditStateButton: false,
    showAnnotationToolStatus: false,
  });


  (window as any).ilastik_debug=false;
  var injection_script = document.createElement("script");
  const ilastikUrl = Url.parse(ILASTIK_URL);
  injection_script.src = ilastikUrl.joinPath("/public/js/inject_into_neuroglancer.js").raw;
  injection_script.onload = () => {
    (window as any).inject_ilastik(
    new URL(ilastikUrl.raw),
    new URL(ilastikUrl.joinPath("/public/css/main.css").raw)
    );
  }
  document.head.appendChild(injection_script)
});
