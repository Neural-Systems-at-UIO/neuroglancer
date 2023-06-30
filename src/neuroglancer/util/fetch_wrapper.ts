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

import { mergeHeaders, Url } from "./url";

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
    if(url.raw.startsWith("https://data-proxy.ebrains.eu/api/")){
        return fetchtFromDataProxy({url, init})
    }else{
        return __origFetch(input, init);
    }
};

async function fetchtFromDataProxy({url, init, unauthorizedRetry=false}: {url: Url, init?: RequestInit, unauthorizedRetry?: boolean}): Promise<Response>{
    if(ebrains_user_access_token === undefined || unauthorizedRetry){
        ebrains_user_access_token = await fetchUserToken()
    }
    let httpMethod = init?.method?.toUpperCase() || "GET";

    let fixedUrl: Url = url
    if((httpMethod == "GET" || httpMethod == "HEAD") && (url.path.raw.startsWith("/api/buckets/") || url.path.raw.startsWith("/api/v1/buckets/")) ){
        fixedUrl = url.updatedWith({extra_search: new Map([["redirect", "false"]])})
    }

    let fixedHeaders = mergeHeaders(init?.headers, new Headers({"Authorization": `Bearer ${ebrains_user_access_token}`}))
    fixedHeaders.delete("range")

    let response = await __origFetch(fixedUrl.raw, {
        ...init,
        method: httpMethod == "HEAD" ? "GET" : httpMethod,
        headers: fixedHeaders,
    });

    if(response.status == 401 && !unauthorizedRetry){
        return fetchtFromDataProxy({url, init, unauthorizedRetry: true})
    }

    if(!response.ok || url.path.name == "stat"){
        return response
    }

    const response_payload = await response.json();
    const cscsObjectUrl = response_payload["url"]
    const resp =  await __origFetch(cscsObjectUrl, init)
    return resp
}

self.fetch = hijackedFetch