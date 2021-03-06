/// <reference path="../pkg/crafthead.d.ts">

import CloudflareWorkerGlobalScope from 'types-cloudflare-worker';
import { MineheadRequest, RequestedKind, interpretRequest } from './request';
import MojangRequestService from './services/mojang';
import { getRenderer } from './wasm';
import { CloudflareCacheService, ArrayBufferCloudflareResponseMapper } from './services/cache/cloudflare';
import MemoryCacheService from './services/cache/memory';
import ResponseCacheService from './services/cache/response_helper';

declare var self: CloudflareWorkerGlobalScope;

self.addEventListener('fetch', event => {
    event.respondWith(handleRequest(event));
})

const l1Cache = new ResponseCacheService(
    new MemoryCacheService(),
    new CloudflareCacheService('general-cache', new ArrayBufferCloudflareResponseMapper())
);
const skinService = new MojangRequestService();

async function handleRequest(event: FetchEvent) {
    const request = event.request;

    // a debug endpoint to diagnose high startup times
    if (request.url.endsWith("/testing1234/ping")) {
        return new Response("ping")
    }

    const interpreted = interpretRequest(request);
    if (!interpreted) {
        // We don't understand this request. Pass it straight to the origin (Amazon S3).
        return fetch(request);
    }

    console.log("Request interpreted as ", interpreted);

    try {
        // If the result is cached, we don't need to do aything else
        const l1CacheResponse = await l1Cache.find(getCacheKey(interpreted))
        if (l1CacheResponse) {
            const headers = decorateHeaders(interpreted, l1CacheResponse.headers)
            return new Response(l1CacheResponse.body, { headers });
        }

        // We failed to be lazy, so we'll have to actually fetch the skin.
        console.log("Request not satisified from cache.");
        const skinResponse = await processRequest(skinService, interpreted);
        if (skinResponse.ok) {
            event.waitUntil(l1Cache.put(getCacheKey(interpreted), skinResponse.clone()));
        }
        const headers = decorateHeaders(interpreted, skinResponse.headers)
        return new Response(skinResponse.body, { headers });
    } catch (e) {
        return new Response(e.toString(), { status: 500 })
    }
}

function decorateHeaders(interpreted: MineheadRequest, headers: Headers): Headers {
    const copiedHeaders = new Headers(headers);

    // Set a liberal CORS policy - there's no harm you can do by making requests to this site...
    copiedHeaders.set('Access-Control-Allow-Origin', '*');
    copiedHeaders.set('Content-Type', interpreted.requested === RequestedKind.Profile ? 'application/json' : 'image/png');
    return copiedHeaders
}

async function processRequest(skinService: MojangRequestService, interpreted: MineheadRequest): Promise<Response> {
    switch (interpreted.requested) {
        case RequestedKind.Profile: {
            const profile = await skinService.fetchMojangProfile(interpreted.identity, interpreted.identityType, null);
            if (profile === null) {
                return new Response(JSON.stringify({ error: "Unable to fetch the profile"}), { status: 500 });
            }
            return new Response(JSON.stringify(profile));
        }
        case RequestedKind.Avatar: {
            const skin = await skinService.retrieveSkin(interpreted.identity, interpreted.identityType);
            return generateHead(skin, interpreted.size);
        }
        case RequestedKind.Skin: {
            const skin = await skinService.retrieveSkin(interpreted.identity, interpreted.identityType);
            return skin;
        }
        default:
            return new Response('must request an avatar, profile, or a skin', { status: 400 });
    }
}

async function generateHead(skin: Response, size: number): Promise<Response> {
    const destinationHeaders = new Headers(skin.headers);
    const skinCacheHit = destinationHeaders.get('X-Minehead-Cache-Hit')
    if (skinCacheHit) {
        destinationHeaders.set('X-Minehead-Skin-Cache-Hit', skinCacheHit)
        destinationHeaders.delete('X-Minehead-Cache-Hit')
    }

    const [renderer, skinArrayBuffer] = await Promise.all([getRenderer(), skin.arrayBuffer()]);
    const skinBuf = new Uint8Array(skinArrayBuffer);
    return new Response(renderer.get_minecraft_head(skinBuf, size), {
        headers: destinationHeaders
    });
}

function getCacheKey(interpreted: MineheadRequest): string {
    return `${interpreted.requested}/${interpreted.identity.toLocaleLowerCase('en-US')}/${interpreted.size}`
}