(() => {
    "use strict";

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (check, { timeoutMs = 30000, intervalMs = 250 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            let value = null;
            try { value = check(); } catch (e) { value = null; }
            if (value) return value;
            if (Date.now() >= deadline) return null;
            await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
        }
    };
    const waitForStable = async (probe, { timeoutMs = 30000, intervalMs = 300, stableRounds = 2 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let lastSignature = null;
        let stableSince = null;
        let value = null;
        while (Date.now() < deadline) {
            value = probe();
            const signature = JSON.stringify(value);
            if (signature === lastSignature) {
                if (stableSince == null) stableSince = Date.now();
                if (Date.now() - stableSince >= stableRounds * intervalMs) return value;
            } else {
                stableSince = null;
                lastSignature = signature;
            }
            await sleep(intervalMs);
        }
        return value;
    };
    const readInitialData = (doc) => {
        const candidates = [];
        const byId = doc.querySelector("script#initial-data");
        if (byId) candidates.push(byId);
        for (const script of doc.querySelectorAll('script[type="application/json"]')) {
            if (script !== byId) candidates.push(script);
        }
        for (const script of candidates) {
            try {
                const data = JSON.parse(script.textContent || "null");
                if (data && typeof data === "object") return data;
            } catch (e) {  }
        }
        return null;
    };
    const walkJson = (data, visit, maxDepth = 12) => {
        const stack = [[data, 0]];
        while (stack.length) {
            const [value, depth] = stack.pop();
            visit(value, depth);
            if (depth >= maxDepth || !value || typeof value !== "object") continue;
            const children = Array.isArray(value) ? value : Object.values(value);
            for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + 1]);
        }
    };
    const CHAPTER_PATH = /^\/title\/([a-z0-9]+)-[^/]+\/(\d+)-chapter-(\d+(?:\.\d+)?)/i;
    const IMAGE_EXT = /\.(?:jpe?g|png|webp|avif|gif)$/i;
    const pathOf = (href) => {
        if (!href) return "";
        if (/^https?:\/\//i.test(href)) {
            try { return new URL(href).pathname; } catch (e) { return href; }
        }
        return href.split(/[?#]/)[0];
    };
    const parseChapterPath = (path) => {
        const match = CHAPTER_PATH.exec(path || "");
        return match ? { hid: match[1], id: Number(match[2]), number: parseFloat(match[3]) } : null;
    };
    const imageSrc = (img) => {
        const src = img.getAttribute("src") || "";
        const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
        if (lazy && (!src || src.startsWith("data:"))) return lazy;
        return src || lazy || null;
    };

    const OPTIONS = Object.assign(
        { timeoutMs: 30000, pollMs: 300, stableRounds: 3 },
        window.__comixHarvestOptions || {});

    const NON_CONTENT = /avatar|icon|logo|emoji|emoticon|sprite|placeholder|blank|loading|spinner|profile|userpic|favicon/i;

    const collect = () => {
        const urls = [];
        for (const img of Array.from(document.querySelectorAll("img"))) {
            const src = imageSrc(img);
            if (!src || src.startsWith("data:")) continue;
            if (!/^https?:\/\//i.test(src)) continue;
            const path = pathOf(src);
            if (NON_CONTENT.test(path)) continue;
            if (!IMAGE_EXT.test(path)) {
                const last = path.split("/").pop() || "";
                if (last.includes(".")) continue;
            }
            let w = img.naturalWidth || img.width || 0;
            let h = img.naturalHeight || img.height || 0;
            if (!w || !h) {
                try {
                    const rect = img.getBoundingClientRect();
                    if (rect) {
                        w = w || Math.round(rect.width) || 0;
                        h = h || Math.round(rect.height) || 0;
                    }
                } catch (e) { }
            }
            if (w > 0 && h > 0 && w < 200 && h < 200) continue;
            if (!urls.includes(src)) urls.push(src);
        }
        return urls;
    };

    const nudgeScroll = () => {
        try { window.scrollBy(0, Math.floor((window.innerHeight || 600) * 0.8)); } catch (e) {  }
        try {
            let best = null;
            for (const el of Array.from(document.querySelectorAll("div, main, section, article"))) {
                if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight * 1.5 &&
                    (!best || el.scrollHeight > best.scrollHeight)) best = el;
            }
            if (best) best.scrollTop += Math.floor((best.clientHeight || 600) * 0.8);
        } catch (e) {  }
    };

    const harvest = async () => {
        const here = parseChapterPath(location.pathname || pathOf(location.href || ""));
        const data = readInitialData(document);

        const corroborated = { chapterId: false, mangaHid: false };
        if (data && here) {
            walkJson(data, (value) => {
                if (value === here.id) corroborated.chapterId = true;
                if (value === here.hid) corroborated.mangaHid = true;
            });
        }

        let images = collect();
        if (!images.length) {
            await waitFor(() => collect().length > 0 || null,
                { timeoutMs: OPTIONS.timeoutMs, intervalMs: OPTIONS.pollMs });
            images = collect();
        }
        if (images.length) {
            const seen = [...images];
            const probe = () => {
                nudgeScroll();
                for (const url of collect()) if (!seen.includes(url)) seen.push(url);
                return seen;
            };
            images = await waitForStable(probe,
                { timeoutMs: OPTIONS.timeoutMs, intervalMs: OPTIONS.pollMs, stableRounds: OPTIONS.stableRounds }) || seen;
        }

        return {
            page: "read",
            chapterId: here ? here.id : null,
            mangaHid: here ? here.hid : null,
            chapterNumber: here ? here.number : null,
            corroborated,
            count: images.length,
            images,
        };
    };

    const done = (result) => {
        window.__comixHarvest = result;
        console.log("[comix-harvest:pages] " + JSON.stringify(result));
    };
    window.__comixHarvestPromise = (async () => {
        try {
            const result = await harvest();
            done(result);
            return result;
        } catch (e) {
            const result = { page: "read", error: String((e && e.message) || e), images: [], count: 0 };
            done(result);
            return result;
        }
    })();
})();
