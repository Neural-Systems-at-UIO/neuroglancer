/**While there is no alternative solution to authenticating with the data proxy,
 * I'll be injecting token headers into requests done by neuroglancer
 * (and other 3rd party libs) when those go to the data-proxy.
 *
 * To do that, this file should run super early, as it hijacks the `fetch` function
 *
 * https://stackoverflow.com/questions/45425169/intercept-fetch-api-requests-and-responses-in-javascript
 *
 * FIXME: try to replace this with a service worker
 */

import { Url } from "./url";

var ebrains_user_access_token: string | undefined = undefined

const __origFetch = self.fetch;

const fetchUserToken = async (): Promise<string> => {
    const token_response = await __origFetch("https://app.ilastik.org/api/get_ebrains_token", {method: "POST"})
    if(!token_response.ok){
        throw TypeError(await token_response.text())
    }
    return (await token_response.json())["ebrains_user_access_token"]
}

export const hijackedFetch = async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = Url.parse(typeof input === "string" ? input : input.destination)
    if(!url.raw.startsWith("https://data-proxy.ebrains.eu/api/")){
        return __origFetch(input, init);
    }

    if(ebrains_user_access_token === undefined){
        ebrains_user_access_token = await fetchUserToken()
    }

    let headers: HeadersInit | undefined = init === undefined ? undefined :  init.headers
    let fixedHeaders: {[key:string]: string} = {}
    if(Array.isArray(headers)){
        headers.forEach(header => fixedHeaders[header[0]] = header[1])
    }else if(headers instanceof Headers){
        for(let header of headers.entries()){
            fixedHeaders[header[0]] = header[1]
        }
    }else if(headers !== undefined){
        fixedHeaders = {...fixedHeaders, ...headers}
    }
    fixedHeaders["Authorization"] = `Bearer ${ebrains_user_access_token}`

    let http_method = (init && init.method && init.method.toUpperCase()) || "GET";

    let fixedInput: RequestInfo
    if(http_method == "GET" && (url.path.raw.startsWith("/api/buckets/") || url.path.raw.startsWith("/api/v1/buckets/")) ){
        fixedInput = url.updatedWith({extra_search: new Map([["redirect", "false"]])}).raw
    }else{
        fixedInput = input
    }

    let response = await __origFetch(fixedInput, {...init, headers: fixedHeaders});
    if(response.status == 401){
        ebrains_user_access_token = await fetchUserToken();
        fixedHeaders["Authorization"] = `Bearer ${ebrains_user_access_token}`
        response = await __origFetch(fixedInput, {...init, headers: fixedHeaders});
    }

    if(url.path.name == "stat"){
        return response
    }

    if(!response.ok){
        return response
    }
    const response_payload = await response.json();
    const cscsObjectUrl = response_payload["url"]
    return await __origFetch(cscsObjectUrl)
};

self.fetch = hijackedFetch