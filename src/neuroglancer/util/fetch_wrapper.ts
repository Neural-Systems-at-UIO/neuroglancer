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

import { ILASTIK_URL } from "../ilastik_api_url";
import { mergeHeaders, Url } from "./url";

type AuthHeaders = {"Authorization": string, "X-Authorization-Refresh": string};

function _readHeaders(): AuthHeaders | Promise<AuthHeaders>{
    return (self as any).ebrains_auth_extra_headers
}
function _writeHeaders(headers: AuthHeaders | Promise<AuthHeaders>): AuthHeaders | Promise<AuthHeaders>{
    return (self as any).ebrains_auth_extra_headers = headers
}

async function getHeaders(refresh: "refresh" | undefined = undefined): Promise<AuthHeaders>{
    const headers = _readHeaders()
    if(!refresh || headers instanceof Promise){
        return headers
    }
    console.log("==>>> Asking webilastik for a refreshed token....");
    return _writeHeaders((async () => {
        const refreshedTokenResponse = await fetch(
            Url.parse(ILASTIK_URL).joinPath("api/refresh_token").raw,
            {
                cache: "no-store",
                method: "POST",
                headers: await getHeaders(),
            },
        )
        if(!refreshedTokenResponse.ok){
            console.error("Could not refresh ebrains token!!!!!!!!!!!!!!!!")
            throw "Could not refresh ebrains token!!!!!!!!!!!!!!!!"
        }
        return makeHeaders(await refreshedTokenResponse.json())
    })());
}

function makeHeaders(token: any): AuthHeaders{
    const access_token = token.access_token
    const refresh_token = token.refresh_token
    if(typeof access_token != "string" || typeof refresh_token != "string"){
        console.error(`Bad access/refresh token!!!!!!!!!!!!!!!!`)
        throw `Bad access/refresh token!!!!!!!!!!!!!!!!}`
    }
    return {
        "Authorization": `Bearer ${token.access_token}`,
        "X-Authorization-Refresh": token.refresh_token,
    }
}

globalThis.addEventListener("message", (ev: MessageEvent): boolean => {
    const payload = ev.data;
    const access_token_key = "access_token"
    if(typeof(payload) != "object" || !(access_token_key in payload) ){
        return true
    }
    console.log(`NEUROGLANCER: ${typeof Window == "function" ? 'window' : 'worker'} just got a token as a message!`)
    _writeHeaders(makeHeaders(payload));
    return true
})

const __origFetch = self.fetch;

export const hijackedFetch = async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = Url.parse(typeof input === "string" ? input : input.destination)
    if(url.raw.startsWith("https://data-proxy.ebrains.eu/api/")){
        return fetchtFromDataProxy({url, init})
    }else{
        return __origFetch(input, init);
    }
};

async function fetchtFromDataProxy({url, init, unauthorizedRetry=false}: {url: Url, init?: RequestInit, unauthorizedRetry?: boolean}): Promise<Response>{
    const extra_headers = await getHeaders(unauthorizedRetry ? "refresh" : undefined)
    let httpMethod = init?.method?.toUpperCase() || "GET";

    let fixedUrl: Url = url
    if((httpMethod == "GET" || httpMethod == "HEAD") && (url.path.raw.startsWith("/api/buckets/") || url.path.raw.startsWith("/api/v1/buckets/")) ){
        fixedUrl = url.updatedWith({extra_search: new Map([["redirect", "false"]])})
    }

    const authorization_header_key = "Authorization"
    let fixedHeaders = mergeHeaders(
        init?.headers,
        {[authorization_header_key]: extra_headers[authorization_header_key]}
    )
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