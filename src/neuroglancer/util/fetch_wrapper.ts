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
export const hijackedFetch = async (input: RequestInfo, init?: RequestInit) => {
    const url = Url.parse(typeof input === "string" ? input : input.destination)
    if(
        url.hostname !== "data-proxy.ebrains.eu" ||
        !url.path.raw.startsWith("/api/")
    ){
        return __origFetch(input, init);
    }

    if(ebrains_user_access_token === undefined){
        const token_response = await fetch("https://app.ilastik.org/api/get_ebrains_token", {method: "POST"})
        if(!token_response.ok){
            throw TypeError(await token_response.text())
        }
        ebrains_user_access_token = (await token_response.json()).ebrains_user_access_token
    }

    const authHeaderName = "Authorization"
    const authHeaderValue = `Bearer ${ebrains_user_access_token}`
    let headers: HeadersInit | undefined = init === undefined ? undefined :  init.headers
    let fixedHeaders: HeadersInit
    if(headers === undefined){
        fixedHeaders = {[authHeaderName]: authHeaderValue}
    }else if(Array.isArray(headers)){
        fixedHeaders = [...headers, [authHeaderName, authHeaderValue]]
    }else if(headers instanceof Headers){
        fixedHeaders = [...headers.entries(), [authHeaderName, authHeaderValue]]
    }else{
        fixedHeaders = {...headers, [authHeaderName]: authHeaderValue}
    }
    const responsePromise = __origFetch(input, {...init, headers: fixedHeaders});

    if(url.path.name == "stat" || init && init.method && init.method.toLowerCase() !== "get"){
        return responsePromise
    }

    const response = await responsePromise
    if(!response.ok){
        return responsePromise
    }
    const response_payload = await response.json();
    const cscsObjectUrl = response_payload["url"]
    return await fetch(cscsObjectUrl)
};

self.fetch = hijackedFetch