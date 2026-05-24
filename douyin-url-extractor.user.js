// ==UserScript==
// @name         Douyin URL Extractor
// @namespace    douyin_url_extractor
// @version      2.4.0
// @description  提取抖音当前页面中已加载的作品、图文和直播链接，可复制链接、名称+链接，并批量取消喜欢/收藏
// @author       local
// @match        *://www.douyin.com/*
// @match        *://douyin.com/*
// @match        *://v.douyin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM.openInTab
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_PREFIX = 'douyin_url_extractor.';
    const BATCH_TASK_KEY = `${STORAGE_PREFIX}batchTask`;
    const BATCH_RESULT_KEY = `${STORAGE_PREFIX}batchResult`;
    const CAPTURE_LOG_KEY = `${STORAGE_PREFIX}captureLog`;
    const BATCH_WORKER_PARAM = 'dy_url_batch_worker';
    const BATCH_WORKER_SESSION_KEY = `${STORAGE_PREFIX}worker`;
    const DEFAULT_CONFIG = {
        autoScroll: false,
        maxScrollCount: 20,
        confirmBeforeCopy: false,
        keepMenuVisible: false,
        keepQuery: false,
    };

    const TYPE_LABELS = {
        video: '视频作品',
        note: '图文作品',
        live: '直播页面',
    };

    const readValue = (key) => GM_getValue(`${STORAGE_PREFIX}${key}`, DEFAULT_CONFIG[key]);
    const writeValue = (key, value) => GM_setValue(`${STORAGE_PREFIX}${key}`, value);

    const config = {
        autoScroll: readValue('autoScroll'),
        maxScrollCount: readValue('maxScrollCount'),
        confirmBeforeCopy: readValue('confirmBeforeCopy'),
        keepMenuVisible: readValue('keepMenuVisible'),
        keepQuery: readValue('keepQuery'),
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const getCleanText = (text, maxLength = 90) => {
        const value = String(text || '').replace(/\s+/g, ' ').trim();
        if (!value) return '';
        return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
    };

    const isDouyinHost = (host) => {
        const value = String(host || '').toLowerCase();
        return value === 'douyin.com' || value.endsWith('.douyin.com');
    };

    const normalizeRawUrl = (rawUrl) => {
        if (!rawUrl) return '';
        return String(rawUrl)
            .trim()
            .replace(/&amp;/g, '&')
            .replace(/\\u002F/g, '/')
            .replace(/\\\//g, '/');
    };

    const cleanId = (value) => {
        const id = decodeURIComponent(String(value || '')).trim();
        return id.replace(/[?#].*$/, '').replace(/\/+$/, '');
    };

    const maybeKeepQuery = (urlObject, canonicalUrl) => {
        if (!config.keepQuery) return canonicalUrl;
        const query = urlObject.search || '';
        const hash = urlObject.hash || '';
        return `${canonicalUrl}${query}${hash}`;
    };

    const canonicalizeDouyinUrl = (rawUrl, allowedTypes = ['video', 'note', 'user', 'live']) => {
        const allowed = new Set(allowedTypes);
        const normalized = normalizeRawUrl(rawUrl);
        if (!normalized || normalized.startsWith('javascript:') || normalized.startsWith('mailto:')) {
            return null;
        }

        let urlObject;
        try {
            if (normalized.startsWith('//')) {
                urlObject = new URL(`${window.location.protocol}${normalized}`);
            } else {
                urlObject = new URL(normalized, window.location.href);
            }
        } catch (error) {
            return null;
        }

        if (!isDouyinHost(urlObject.hostname)) return null;

        const pathname = urlObject.pathname.replace(/\/{2,}/g, '/');
        let match;

        match = pathname.match(/^\/(?:share\/)?video\/([^/?#]+)/i);
        if (match && allowed.has('video')) {
            const id = cleanId(match[1]);
            if (id) {
                const canonical = `https://www.douyin.com/video/${id}`;
                return {
                    type: 'video',
                    id,
                    url: maybeKeepQuery(urlObject, canonical),
                    rawUrl: urlObject.href,
                };
            }
        }

        match = pathname.match(/^\/(?:share\/)?note\/([^/?#]+)/i);
        if (match && allowed.has('note')) {
            const id = cleanId(match[1]);
            if (id) {
                const canonical = `https://www.douyin.com/note/${id}`;
                return {
                    type: 'note',
                    id,
                    url: maybeKeepQuery(urlObject, canonical),
                    rawUrl: urlObject.href,
                };
            }
        }

        match = pathname.match(/^\/(?:share\/)?user\/([^/?#]+)/i);
        const secUid = match ? match[1] : urlObject.searchParams.get('sec_uid');
        if (secUid && allowed.has('user')) {
            const id = cleanId(secUid);
            if (id) {
                const canonical = `https://www.douyin.com/user/${id}`;
                return {
                    type: 'user',
                    id,
                    url: maybeKeepQuery(urlObject, canonical),
                    rawUrl: urlObject.href,
                };
            }
        }

        match = pathname.match(/^\/live\/([^/?#]+)/i);
        if (match && allowed.has('live')) {
            const id = cleanId(match[1]);
            if (id) {
                const canonical = `https://www.douyin.com/live/${id}`;
                return {
                    type: 'live',
                    id,
                    url: maybeKeepQuery(urlObject, canonical),
                    rawUrl: urlObject.href,
                };
            }
        }

        const modalId = urlObject.searchParams.get('modal_id')
            || urlObject.searchParams.get('aweme_id')
            || urlObject.searchParams.get('awemeId')
            || urlObject.searchParams.get('item_id');
        if (modalId && allowed.has('video') && /^\d{8,}$/.test(modalId)) {
            const id = cleanId(modalId);
            return {
                type: 'video',
                id,
                url: `https://www.douyin.com/video/${id}`,
                rawUrl: urlObject.href,
            };
        }

        return null;
    };

    const getElementTitle = (element, parsed) => {
        if (!element) return '';

        const direct = getCleanText(
            element.getAttribute('title')
            || element.getAttribute('aria-label')
            || element.getAttribute('alt')
        );
        if (direct) return direct;

        const imageAlt = getCleanText(element.querySelector?.('img[alt]')?.getAttribute('alt'));
        if (imageAlt) return imageAlt;

        const ownText = getCleanText(element.innerText || element.textContent);
        if (ownText) return ownText;

        const card = element.closest?.('article, li, [role="listitem"], [data-e2e], [data-testid], section, div');
        const titled = getCleanText(card?.querySelector?.('[title]')?.getAttribute('title'));
        if (titled) return titled;

        const labelled = getCleanText(card?.querySelector?.('[aria-label]')?.getAttribute('aria-label'));
        if (labelled) return labelled;

        const cardImageAlt = getCleanText(card?.querySelector?.('img[alt]')?.getAttribute('alt'));
        if (cardImageAlt) return cardImageAlt;

        const cardText = getCleanText(card?.innerText || card?.textContent);
        if (cardText) return cardText;

        if (parsed?.id) return `${TYPE_LABELS[parsed.type] || '作品'} ${parsed.id}`;
        return parsed?.url || '';
    };

    const getImageFromSrcset = (srcset) => {
        const first = String(srcset || '').split(',')[0]?.trim();
        if (!first) return '';
        return first.split(/\s+/)[0] || '';
    };

    const getElementCover = (element) => {
        if (!element) return '';
        const card = element.closest?.('article, li, [role="listitem"], [data-e2e], [data-testid], section, div') || element;
        const image = card.querySelector?.('img[src], img[srcset], picture img');
        const raw = image?.getAttribute('src')
            || image?.currentSrc
            || getImageFromSrcset(image?.getAttribute('srcset'))
            || '';
        if (!raw || raw.startsWith('data:')) return '';
        try {
            return new URL(raw, window.location.href).href;
        } catch (error) {
            return raw;
        }
    };

    const createItem = (parsed, sourceElement) => ({
        ...parsed,
        label: TYPE_LABELS[parsed.type] || parsed.type,
        title: getElementTitle(sourceElement, parsed),
        cover: getElementCover(sourceElement),
    });

    const collectFromAnchors = (types) => {
        const items = [];
        document.querySelectorAll('a[href]').forEach((anchor) => {
            const parsed = canonicalizeDouyinUrl(anchor.getAttribute('href'), types);
            if (parsed) items.push(createItem(parsed, anchor));
        });
        return items;
    };

    const collectFromMeta = (types) => {
        const items = [];
        document.querySelectorAll('link[rel="canonical"][href], meta[property="og:url"][content], meta[name="og:url"][content]').forEach((node) => {
            const raw = node.getAttribute('href') || node.getAttribute('content');
            const parsed = canonicalizeDouyinUrl(raw, types);
            if (parsed) items.push(createItem(parsed, node));
        });
        return items;
    };

    const collectCurrentIfMatches = (types) => {
        const parsed = canonicalizeDouyinUrl(window.location.href, types);
        return parsed ? [createItem(parsed, document.body)] : [];
    };

    const uniqueItems = (items) => {
        const map = new Map();
        items.forEach((item) => {
            if (!item?.url || map.has(item.url)) return;
            map.set(item.url, item);
        });
        return Array.from(map.values());
    };

    const collectLinks = (types) => uniqueItems([
        ...collectCurrentIfMatches(types),
        ...collectFromMeta(types),
        ...collectFromAnchors(types),
    ]);

    const copyToClipboard = (text) => {
        if (!text) return;
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text, 'text');
            return;
        }
        navigator.clipboard?.writeText(text);
    };

    const showToast = (message, duration = 2600) => {
        const oldToast = document.querySelector('.dy-url-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = 'dy-url-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('dy-url-toast-visible');
        });

        setTimeout(() => {
            toast.classList.remove('dy-url-toast-visible');
            setTimeout(() => toast.remove(), 220);
        }, duration);
    };

    const getScrollTarget = () => {
        const candidates = [
            document.scrollingElement,
            document.documentElement,
            document.body,
            ...Array.from(document.querySelectorAll('main, [role="main"], [data-e2e], div'))
                .filter((element) => {
                    const style = getComputedStyle(element);
                    if (!/(auto|scroll|overlay)/i.test(`${style.overflowY} ${style.overflow}`)) return false;
                    return element.scrollHeight > element.clientHeight + 80;
                }),
        ].filter(Boolean);

        return candidates
            .map((element) => ({
                element,
                room: (element.scrollHeight || 0) - (element.clientHeight || window.innerHeight),
            }))
            .sort((a, b) => b.room - a.room)[0]?.element || document.scrollingElement || document.documentElement;
    };

    const getScrollState = (target) => {
        const isWindowTarget = target === document.body
            || target === document.documentElement
            || target === document.scrollingElement;
        if (isWindowTarget) {
            const top = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
            const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            return {top, clientHeight: window.innerHeight, scrollHeight: height};
        }
        return {
            top: target.scrollTop,
            clientHeight: target.clientHeight,
            scrollHeight: target.scrollHeight,
        };
    };

    const scrollOnce = (target) => {
        const distance = Math.max(650, Math.floor(window.innerHeight * 0.9));
        if (target === document.body || target === document.documentElement || target === document.scrollingElement) {
            window.scrollBy({top: distance, behavior: 'smooth'});
            document.documentElement.scrollTop += distance;
            document.body.scrollTop += distance;
            window.dispatchEvent(new WheelEvent('wheel', {deltaY: distance, bubbles: true, cancelable: true}));
            return;
        }

        target.scrollBy?.({top: distance, behavior: 'smooth'});
        target.scrollTop += distance;
        target.dispatchEvent(new WheelEvent('wheel', {deltaY: distance, bubbles: true, cancelable: true}));
    };

    const isNearBottom = (target) => {
        const state = getScrollState(target);
        return state.scrollHeight - (state.top + state.clientHeight) < 60;
    };

    const autoScrollIfNeeded = async () => {
        if (!config.autoScroll) return;
        showToast(`正在自动滚动加载页面，最多 ${config.maxScrollCount} 次...`, 1800);
        for (let index = 0; index < Number(config.maxScrollCount || 0); index += 1) {
            const target = getScrollTarget();
            const before = getScrollState(target);
            if (isNearBottom(target)) break;
            scrollOnce(target);
            await sleep(850);
            const after = getScrollState(target);
            if (after.top === before.top && after.scrollHeight === before.scrollHeight) {
                break;
            }
        }
        await sleep(800);
    };

    const formatTitleForCopy = (item) => {
        const title = getCleanText(item.title, 300) || `${item.label || '作品'} ${item.id || ''}`.trim() || item.url;
        return title.replace(/[\t\r\n]+/g, ' ').trim();
    };

    const formatUrls = (items) => items.map((item) => item.url).join('\n');

    const formatUrlsWithTitles = (items) => items
        .map((item) => `${formatTitleForCopy(item)}\t${item.url}`)
        .join('\n');

    const copyItems = (items, options = {}) => {
        const validItems = uniqueItems(items);
        if (!validItems.length) {
            showToast('没有提取到可用链接');
            return;
        }

        const includeTitle = Boolean(options.includeTitle);
        copyToClipboard(includeTitle ? formatUrlsWithTitles(validItems) : formatUrls(validItems));
        showToast(`已复制 ${validItems.length} 条${includeTitle ? '名称+链接' : '链接'}到剪贴板`);
    };

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const showSelectionModal = (items) => new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'dy-url-overlay';
        overlay.innerHTML = `
            <div class="dy-url-modal" role="dialog" aria-modal="true">
                <div class="dy-url-modal-header">
                    <div>
                        <div class="dy-url-modal-title">选择要复制的链接</div>
                        <div class="dy-url-modal-subtitle">已提取 ${items.length} 个链接</div>
                    </div>
                    <button class="dy-url-icon-button" type="button" data-action="close" aria-label="关闭">×</button>
                </div>
                <div class="dy-url-list"></div>
                <div class="dy-url-modal-footer">
                    <button class="dy-url-secondary-button" type="button" data-action="select-all">全选</button>
                    <button class="dy-url-secondary-button" type="button" data-action="select-none">全不选</button>
                    <button class="dy-url-primary-button" type="button" data-action="copy">复制选中</button>
                </div>
            </div>
        `;

        const list = overlay.querySelector('.dy-url-list');
        items.forEach((item, index) => {
            const row = document.createElement('label');
            row.className = 'dy-url-list-row';
            row.innerHTML = `
                <input type="checkbox" checked data-index="${index}">
                <span class="dy-url-row-content">
                    <span class="dy-url-row-title">${escapeHtml(item.title || item.url)}</span>
                    <span class="dy-url-row-meta">${escapeHtml(item.label)} · ${escapeHtml(item.url)}</span>
                </span>
            `;
            list.appendChild(row);
        });

        const close = (value) => {
            overlay.remove();
            resolve(value);
        };

        overlay.addEventListener('click', (event) => {
            const action = event.target?.dataset?.action;
            if (event.target === overlay || action === 'close') {
                close(null);
                return;
            }

            if (action === 'select-all' || action === 'select-none') {
                const checked = action === 'select-all';
                overlay.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
                    checkbox.checked = checked;
                });
                return;
            }

            if (action === 'copy') {
                const selected = [];
                overlay.querySelectorAll('input[type="checkbox"]:checked').forEach((checkbox) => {
                    const item = items[Number(checkbox.dataset.index)];
                    if (item) selected.push(item);
                });
                close(selected);
            }
        });

        document.body.appendChild(overlay);
    });

    const showWorkSelectionModal = (items, actionLabel) => new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'dy-url-overlay';
        overlay.innerHTML = `
            <div class="dy-url-modal" role="dialog" aria-modal="true">
                <div class="dy-url-modal-header">
                    <div>
                        <div class="dy-url-modal-title">选择要${escapeHtml(actionLabel)}的作品</div>
                        <div class="dy-url-modal-subtitle">已提取 ${items.length} 个作品。请只勾选你确认要处理的项目。</div>
                    </div>
                    <button class="dy-url-icon-button" type="button" data-action="close" aria-label="关闭">×</button>
                </div>
                <div class="dy-url-work-list"></div>
                <div class="dy-url-modal-footer">
                    <button class="dy-url-secondary-button" type="button" data-action="select-all">全选</button>
                    <button class="dy-url-secondary-button" type="button" data-action="select-none">全不选</button>
                    <button class="dy-url-primary-button" type="button" data-action="confirm">开始${escapeHtml(actionLabel)}</button>
                </div>
            </div>
        `;

        const list = overlay.querySelector('.dy-url-work-list');
        items.forEach((item, index) => {
            const row = document.createElement('label');
            row.className = 'dy-url-work-row';
            const coverHtml = item.cover
                ? `<img class="dy-url-work-cover" src="${escapeHtml(item.cover)}" alt="">`
                : `<span class="dy-url-work-cover dy-url-work-cover-empty">无封面</span>`;
            row.innerHTML = `
                <input type="checkbox" checked data-index="${index}">
                ${coverHtml}
                <span class="dy-url-row-content">
                    <span class="dy-url-row-title">${escapeHtml(item.title || item.url)}</span>
                    <span class="dy-url-row-meta">${escapeHtml(item.label)} · ${escapeHtml(item.url)}</span>
                </span>
            `;
            list.appendChild(row);
        });

        const close = (value) => {
            overlay.remove();
            resolve(value);
        };

        overlay.addEventListener('click', (event) => {
            const action = event.target?.dataset?.action;
            if (event.target === overlay || action === 'close') {
                close(null);
                return;
            }

            if (action === 'select-all' || action === 'select-none') {
                const checked = action === 'select-all';
                overlay.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
                    checkbox.checked = checked;
                });
                return;
            }

            if (action === 'confirm') {
                const selected = [];
                overlay.querySelectorAll('input[type="checkbox"]:checked').forEach((checkbox) => {
                    const item = items[Number(checkbox.dataset.index)];
                    if (item) selected.push(item);
                });
                close(selected);
            }
        });

        document.body.appendChild(overlay);
    });

    const extractAndCopy = async (types, options = {}) => {
        await autoScrollIfNeeded();
        const items = collectLinks(types);

        if (!items.length) {
            showToast('没有提取到可用链接。可以先手动滚动页面，等内容加载后再试。');
            return;
        }

        if (config.confirmBeforeCopy && items.length > 1) {
            const selected = await showSelectionModal(items);
            if (selected) copyItems(selected, options);
            return;
        }

        copyItems(items, options);
    };

    const getStoredJson = (key, fallback = null) => {
        try {
            const raw = GM_getValue(key, '');
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            return fallback;
        }
    };

    const setStoredJson = (key, value) => {
        GM_setValue(key, JSON.stringify(value));
    };

    const getCapturedApiEntry = (pattern) => {
        const logs = getStoredJson(CAPTURE_LOG_KEY, []);
        return [...logs].reverse().find((entry) => pattern.test(entry.url || entry.responseUrl || '')) || null;
    };

    const clearBatchTask = () => {
        GM_setValue(BATCH_TASK_KEY, '');
    };

    const forceHideMenu = () => {
        window.clearTimeout(hideTimer);
        menuElement?.classList.remove('dy-url-menu-open');
    };

    const stopBatchTask = () => {
        forceHideMenu();
        clearBatchTask();
        showToast('已停止当前批量任务');
    };

    const getBatchActionLabel = (action) => action === 'favorite' ? '取消收藏' : '取消喜欢';

    const getDouyinTicketKey = () => {
        try {
            const raw = localStorage.getItem('security-sdk/s_sdk_cert_key');
            const parsed = raw ? JSON.parse(raw) : null;
            return String(parsed?.data || '').replace(/^pub\./, '');
        } catch (error) {
            return '';
        }
    };

    const createDetailedError = (message, details = {}) => {
        const error = new Error(message);
        error.details = details;
        return error;
    };

    const getPageFetch = () => unsafeWindow?.fetch?.bind(unsafeWindow) || window.fetch.bind(window);

    const cancelLikeByApi = async (item) => {
        const key = getDouyinTicketKey();
        const body = new URLSearchParams({
            aweme_id: item.id,
            item_type: '0',
            type: '0',
        });
        const headers = {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        };
        if (key) headers['bd-ticket-guard-ree-public-key'] = key;

        const pageFetch = getPageFetch();
        const response = await pageFetch('https://www.douyin.com/aweme/v1/web/commit/item/digg/?aid=6383', {
            headers,
            referrer: item.url,
            referrerPolicy: 'strict-origin-when-cross-origin',
            body: body.toString(),
            method: 'POST',
            mode: 'cors',
            credentials: 'include',
        });

        let payload = null;
        let responseText = '';
        try {
            responseText = await response.clone().text();
            payload = responseText ? JSON.parse(responseText) : null;
        } catch (error) {
            payload = null;
        }

        const details = {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            responseText: responseText.slice(0, 1000),
            payload,
            hasTicketKey: Boolean(key),
            itemId: item.id,
            itemUrl: item.url,
        };

        if (!response.ok) {
            throw createDetailedError(`HTTP ${response.status}`, details);
        }
        if (payload && payload.status_code !== undefined && payload.status_code !== 0) {
            throw createDetailedError(payload.status_msg || `status_code ${payload.status_code}`, details);
        }
        return payload || {ok: true};
    };

    const cancelLikesByApi = async (items) => {
        let done = 0;
        let failed = 0;
        const results = [];
        showToast(`开始取消喜欢：共 ${items.length} 个作品`, 1800);

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            try {
                await cancelLikeByApi(item);
                done += 1;
                results.push({...item, status: 'done', message: '接口取消成功', time: Date.now()});
                showToast(`取消喜欢进度 ${index + 1}/${items.length}，成功 ${done} 个`, 1200);
            } catch (error) {
                failed += 1;
                results.push({
                    ...item,
                    status: 'failed',
                    message: error?.message || '接口请求失败',
                    details: error?.details || null,
                    time: Date.now(),
                });
                showToast(`取消喜欢进度 ${index + 1}/${items.length}，失败 ${failed} 个`, 1200);
            }
            await sleep(700);
        }

        setStoredJson(BATCH_RESULT_KEY, {
            action: 'like',
            results,
            finishedAt: Date.now(),
        });
        showToast(`取消喜欢完成：成功 ${done} 个，失败 ${failed} 个`, 6000);
        return {done, failed, results};
    };

    const getFavoriteApiTemplate = () => {
        const captured = getCapturedApiEntry(/\/aweme\/v1\/web\/aweme\/collect\//);
        if (!captured) {
            return {
                url: '/aweme/v1/web/aweme/collect/?aid=6383',
                headers: {},
                capturedAction: '',
                awemeType: '0',
            };
        }
        const rawUrl = captured.url || captured.responseUrl;
        try {
            const urlObject = new URL(rawUrl, window.location.origin);
            urlObject.searchParams.delete('msToken');
            urlObject.searchParams.delete('a_bogus');
            if (!urlObject.searchParams.get('aid')) {
                urlObject.searchParams.set('aid', '6383');
            }
            return {
                url: `${urlObject.pathname}${urlObject.search}`,
                headers: captured.requestHeaders || {},
                capturedAction: new URLSearchParams(captured.requestBody || '').get('action') || '',
                awemeType: new URLSearchParams(captured.requestBody || '').get('aweme_type') || '0',
            };
        } catch (error) {
            return {
                url: '/aweme/v1/web/aweme/collect/?aid=6383',
                headers: {},
                capturedAction: '',
                awemeType: '0',
            };
        }
    };

    const getFavoriteReferrer = (item) => {
        try {
            const referrer = new URL(window.location.href);
            if (!/\/user\/self/i.test(referrer.pathname)) {
                referrer.pathname = '/user/self';
            }
            referrer.searchParams.set('modal_id', item.id);
            referrer.searchParams.set('showTab', 'favorite_collection');
            referrer.hash = '';
            return referrer.href;
        } catch (error) {
            return `https://www.douyin.com/user/self?modal_id=${encodeURIComponent(item.id)}&showTab=favorite_collection`;
        }
    };

    const pageFetchText = async (url, options = {}) => {
        const pageFetch = getPageFetch();
        const response = await pageFetch(url, {
            mode: 'cors',
            credentials: 'include',
            referrerPolicy: 'strict-origin-when-cross-origin',
            ...options,
        });
        const responseText = await response.clone().text().catch(() => '');
        let payload = null;
        try {
            payload = responseText ? JSON.parse(responseText) : null;
        } catch (error) {
            payload = null;
        }
        return {response, responseText, payload};
    };

    const normalizeBooleanFlag = (value) => {
        if (value === true || value === 1 || value === '1') return true;
        if (value === false || value === 0 || value === '0') return false;
        return null;
    };

    const readFavoriteStateFromDetail = (payload) => {
        const detail = payload?.aweme_detail || payload?.aweme || payload?.item_info?.item || payload;
        const fields = [
            ['is_collected', detail?.is_collected],
            ['is_collect', detail?.is_collect],
            ['is_collects_selected', detail?.is_collects_selected],
            ['collect_status', detail?.collect_status],
            ['status.is_collected', detail?.status?.is_collected],
            ['status.collect_status', detail?.status?.collect_status],
        ]
            .map(([name, value]) => ({name, value: normalizeBooleanFlag(value), raw: value}))
            .filter((field) => field.value !== null);

        if (!fields.length) {
            return {known: false, isCollected: null, fields: []};
        }
        return {
            known: true,
            isCollected: fields.some((field) => field.value === true),
            fields,
        };
    };

    const fetchAwemeDetailForVerify = async (item) => {
        const key = getDouyinTicketKey();
        const headers = {
            'accept': 'application/json, text/plain, */*',
        };
        if (key) headers['bd-ticket-guard-ree-public-key'] = key;

        const url = `/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(item.id)}&aid=6383`;
        const {response, responseText, payload} = await pageFetchText(url, {
            headers,
            method: 'GET',
            referrer: item.url,
        });
        const details = {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            responseText: responseText.slice(0, 1000),
            payload,
        };
        if (!response.ok) {
            throw createDetailedError(`HTTP ${response.status}`, details);
        }
        if (payload && payload.status_code !== undefined && payload.status_code !== 0) {
            throw createDetailedError(payload.status_msg || `status_code ${payload.status_code}`, details);
        }
        return {payload, details};
    };

    const itemMatchesAweme = (aweme, item) => {
        const ids = [
            aweme?.id,
            aweme?.aweme_id,
            aweme?.aweme_id_str,
            aweme?.aweme_id?.toString?.(),
            aweme?.item_id,
            aweme?.item_id_str,
            aweme?.video?.id,
            aweme?.aweme_info?.aweme_id,
            aweme?.aweme_info?.aweme_id_str,
            aweme?.item?.aweme_id,
            aweme?.item?.aweme_id_str,
        ].filter((value) => value !== undefined && value !== null);
        return ids.some((id) => String(id) === String(item.id));
    };

    const verifyNotInFavoriteList = async (item) => {
        const key = getDouyinTicketKey();
        const headers = {'accept': 'application/json, text/plain, */*'};
        if (key) headers['bd-ticket-guard-ree-public-key'] = key;

        let cursor = 0;
        const pages = [];
        for (let page = 0; page < 6; page += 1) {
            const url = `/aweme/v1/web/collects/list/?aid=6383&count=100&cursor=${encodeURIComponent(cursor)}`;
            const {response, responseText, payload} = await pageFetchText(url, {
                headers,
                method: 'GET',
                referrer: getFavoriteReferrer(item),
            });
            const awemeList = [
                ...(Array.isArray(payload?.aweme_list) ? payload.aweme_list : []),
                ...(Array.isArray(payload?.collects_list) ? payload.collects_list : []),
            ];
            const pageDetails = {
                url: response.url,
                status: response.status,
                statusText: response.statusText,
                count: awemeList.length,
                hasMore: payload?.has_more,
                cursor: payload?.cursor,
                maxCursor: payload?.max_cursor,
                responseText: responseText.slice(0, 600),
            };
            pages.push(pageDetails);

            if (!response.ok) {
                return {known: false, error: `HTTP ${response.status}`, pages};
            }
            if (payload && payload.status_code !== undefined && payload.status_code !== 0) {
                return {known: false, error: payload.status_msg || `status_code ${payload.status_code}`, pages};
            }
            if (awemeList.some((aweme) => itemMatchesAweme(aweme, item))) {
                return {known: true, stillListed: true, pages};
            }
            if (!payload?.has_more || !awemeList.length) {
                return {known: true, stillListed: false, pages};
            }

            const nextCursor = Number(payload.cursor || payload.max_cursor || 0);
            if (!nextCursor || nextCursor === cursor) break;
            cursor = nextCursor;
            await sleep(250);
        }

        return {known: false, error: '收藏列表过长，未能完成状态确认', pages};
    };

    const verifyFavoriteCancelled = async (item, apiDetails) => {
        await sleep(900);
        const listState = await verifyNotInFavoriteList(item);
        if (listState.known && listState.stillListed) {
            throw createDetailedError('接口返回成功，但收藏列表里仍能查到该作品', {
                ...apiDetails,
                listState,
            });
        }
        if (listState.known && !listState.stillListed) {
            return {
                ...apiDetails,
                listState,
            };
        }
        if (/showTab=favorite_collection|favorite_collection/i.test(window.location.href)) {
            throw createDetailedError('接口返回成功，但无法确认收藏列表已移除该作品', {
                ...apiDetails,
                listState,
            });
        }

        const detailResult = await fetchAwemeDetailForVerify(item);
        const favoriteState = readFavoriteStateFromDetail(detailResult.payload);
        const details = {
            ...apiDetails,
            listState,
            verify: detailResult.details,
            favoriteState,
        };
        if (!favoriteState.known) {
            throw createDetailedError('接口返回成功，但无法确认作品已取消收藏', details);
        }
        if (favoriteState.isCollected) {
            throw createDetailedError('接口返回成功，但作品详情仍显示已收藏', details);
        }
        return details;
    };

    const cancelFavoriteByApi = async (item) => {
        const template = getFavoriteApiTemplate();
        if (!template?.url) {
            throw createDetailedError('缺少收藏接口地址', {
                itemId: item.id,
                itemUrl: item.url,
            });
        }
        const body = new URLSearchParams({
            action: '0',
            aweme_id: item.id,
            aweme_type: template.awemeType,
        }).toString();
        const key = getDouyinTicketKey();
        const url = template.url;
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-secsdk-csrf-token': 'DOWNGRADE',
            ...(template.headers.uifid ? {uifid: template.headers.uifid} : {}),
        };
        if (key) headers['bd-ticket-guard-ree-public-key'] = key;

        const {response, responseText, payload} = await pageFetchText(url, {
            headers,
            referrer: getFavoriteReferrer(item),
            body,
            method: 'POST',
        });

        const details = {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            responseText: responseText.slice(0, 1000),
            payload,
            itemId: item.id,
            itemUrl: item.url,
            requestUrl: url,
            requestBody: body,
            action: '0',
            capturedAction: template.capturedAction,
            awemeType: template.awemeType,
            hasUifidHeader: Boolean(template.headers.uifid),
            hasTicketKey: Boolean(key),
        };

        if (!response.ok) {
            throw createDetailedError(`HTTP ${response.status}`, details);
        }
        if (payload && payload.status_code !== undefined && payload.status_code !== 0) {
            throw createDetailedError(payload.status_msg || `status_code ${payload.status_code}`, details);
        }
        if (payload?.extra?.fatal_item_ids?.some?.((id) => String(id) === String(item.id))) {
            throw createDetailedError('接口返回 fatal_item_ids，未取消收藏', details);
        }
        if (!payload || payload.collects_flag !== false) {
            throw createDetailedError('接口未确认取消收藏成功', details);
        }

        const verifiedDetails = await verifyFavoriteCancelled(item, details);
        return {payload: payload || {ok: true}, details: verifiedDetails};
    };

    const cancelFavoritesByApi = async (items) => {
        let done = 0;
        let failed = 0;
        const results = [];
        showToast(`开始取消收藏：共 ${items.length} 个作品`, 1800);

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            try {
                const apiResult = await cancelFavoriteByApi(item);
                done += 1;
                results.push({
                    ...item,
                    status: 'done',
                    message: '接口取消收藏成功',
                    details: apiResult.details,
                    time: Date.now(),
                });
                showToast(`取消收藏进度 ${index + 1}/${items.length}，成功 ${done} 个`, 1200);
            } catch (error) {
                failed += 1;
                results.push({
                    ...item,
                    status: 'failed',
                    message: error?.message || '收藏接口请求失败',
                    details: error?.details || null,
                    time: Date.now(),
                });
                showToast(`取消收藏进度 ${index + 1}/${items.length}，失败 ${failed} 个`, 1200);
            }
            await sleep(700);
        }

        setStoredJson(BATCH_RESULT_KEY, {
            action: 'favorite',
            results,
            finishedAt: Date.now(),
        });
        showToast(`取消收藏完成：成功 ${done} 个，失败 ${failed} 个`, 6000);
        return {done, failed, results};
    };

    const getBatchSelectors = (action) => {
        if (action === 'favorite') {
            return [
                '[data-e2e*="favorite"]',
                '[data-e2e*="collect"]',
                '[data-e2e*="star"]',
                '[aria-pressed="true"]',
                '[aria-label*="已收藏"]',
                '[aria-label*="收藏"]',
                'button',
                '[role="button"]',
            ];
        }

        return [
            '[data-e2e*="like"]',
            '[aria-pressed="true"]',
            '[aria-label*="已点赞"]',
            '[aria-label*="喜欢"]',
            '[aria-label*="点赞"]',
            'button',
            '[role="button"]',
        ];
    };

    const getElementColorText = (element) => {
        const nodes = [
            element,
            ...Array.from(element.querySelectorAll?.('svg, path, use, span, div') || []).slice(0, 20),
        ];
        return nodes.map((node) => {
            const style = getComputedStyle(node);
            return [
                style.color,
                style.fill,
                style.stroke,
                node.getAttribute?.('fill'),
                node.getAttribute?.('stroke'),
            ].join(' ');
        }).join(' ');
    };

    const isOwnUiElement = (element) => Boolean(element?.closest?.(
        '.dy-url-menu, .dy-url-launcher, .dy-url-overlay, .dy-url-toast'
    ));

    const getElementSearchText = (element) => getCleanText([
            element.getAttribute('aria-label'),
            element.getAttribute('aria-pressed'),
            element.getAttribute('title'),
            element.dataset?.e2e,
            element.innerText,
            element.textContent,
            element.className,
        ].filter(Boolean).join(' '), 220);

    const getBatchButtonScore = (element, action) => {
        if (!element || element.offsetParent === null || isOwnUiElement(element)) return -999;
        const text = getElementSearchText(element);
        const colorText = getElementColorText(element);
        const pressed = element.getAttribute('aria-pressed') === 'true';
        let score = pressed ? 35 : 0;

        if (/分享|评论|举报|更多|搜索|登录|关注|私信|share|comment|follow|message/i.test(text)) {
            score -= 120;
        }

        if (action === 'favorite') {
            if (/取消收藏|已收藏|collected|unfavorite|uncollect/i.test(text)) score += 100;
            if (/收藏|collect|favorite|star/i.test(text)) score += 35;
            if (/rgb\(255,\s*196,\s*0\)|rgb\(255,\s*204,\s*0\)|rgb\(250,\s*206,\s*21\)|#ffc400|#face15|#ffd/i.test(colorText)) score += 65;
            if (/喜欢|点赞|like/i.test(text)) score -= 40;
            return score;
        }

        if (/取消喜欢|取消点赞|已喜欢|已点赞|liked|unlike/i.test(text)) score += 100;
        if (/喜欢|点赞|like/i.test(text)) score += 35;
        if (/rgb\(254,\s*44,\s*85\)|rgb\(255,\s*0,\s*80\)|#fe2c55|red/i.test(colorText)) score += 65;
        if (/收藏|collect|favorite|star/i.test(text)) score -= 45;
        return score;
    };

    const getClickableElement = (element) => element?.querySelector?.('[tabindex], button, [role="button"]')
        || element?.closest?.('button, [role="button"], [tabindex]')
        || element;

    const getElementBrief = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
            tag: element.tagName,
            className: String(element.className || '').slice(0, 200),
            dataE2e: element.getAttribute?.('data-e2e') || '',
            ariaLabel: element.getAttribute?.('aria-label') || '',
            ariaPressed: element.getAttribute?.('aria-pressed') || '',
            title: element.getAttribute?.('title') || '',
            text: getCleanText(element.innerText || element.textContent, 120),
            visible: element.offsetParent !== null,
            rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            },
            colorText: getElementColorText(element).slice(0, 300),
        };
    };

    const findBatchActionButtonFromToolbar = (action) => {
        const toolbars = Array.from(document.querySelectorAll('.iuHPvNF7, [class*="iuHPvNF7"]'));
        for (const toolbar of toolbars) {
            const rows = Array.from(toolbar.children).filter((row) => row.querySelector?.('svg'));
            const row = action === 'favorite' ? rows[2] : rows[0];
            const clickable = getClickableElement(row);
            if (
                clickable
                && !isOwnUiElement(clickable)
                && getBatchButtonScore(row, action) >= 60
            ) {
                return clickable;
            }
        }
        return null;
    };

    const findBatchActionButton = (action) => {
        const toolbarButton = findBatchActionButtonFromToolbar(action);
        if (toolbarButton) return toolbarButton;

        const candidates = [];
        getBatchSelectors(action).forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
                if (!candidates.includes(element)) candidates.push(element);
            });
        });

        return candidates
            .map((element) => ({
                element,
                score: getBatchButtonScore(element, action),
            }))
            .filter((item) => item.score >= 60)
            .sort((a, b) => b.score - a.score)[0]?.element || null;
    };

    const waitForBatchButton = async (action, timeout = 10000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
            const button = findBatchActionButton(action);
            if (button) return button;
            await sleep(500);
        }
        return null;
    };

    const withWorkerParam = (url) => {
        try {
            const urlObject = new URL(url, window.location.href);
            urlObject.searchParams.set(BATCH_WORKER_PARAM, '1');
            urlObject.hash = BATCH_WORKER_PARAM;
            return urlObject.href;
        } catch (error) {
            return url;
        }
    };

    const hasBatchWorkerMarker = () => {
        const params = new URLSearchParams(window.location.search);
        return params.get(BATCH_WORKER_PARAM) === '1' || window.location.hash.includes(BATCH_WORKER_PARAM);
    };

    const markBatchWorkerPage = () => {
        if (hasBatchWorkerMarker()) {
            sessionStorage.setItem(BATCH_WORKER_SESSION_KEY, '1');
        }
    };

    const isBatchWorkerPage = () => hasBatchWorkerMarker()
        || sessionStorage.getItem(BATCH_WORKER_SESSION_KEY) === '1';

    const openBatchTarget = (item) => {
        window.location.assign(withWorkerParam(item.url));
    };

    const openBatchWorker = (item) => {
        const workerUrl = withWorkerParam(item.url);
        if (typeof GM_openInTab === 'function') {
            try {
                const tab = GM_openInTab(workerUrl, {
                    active: true,
                    insert: true,
                    setParent: true,
                });
                return Boolean(tab) || true;
            } catch (error) {
                try {
                    const tab = GM_openInTab(workerUrl, true);
                    return Boolean(tab) || true;
                } catch (innerError) {
                    // fall through
                }
            }
        }
        if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
            try {
                GM.openInTab(workerUrl, {
                    active: true,
                    insert: true,
                    setParent: true,
                });
                return true;
            } catch (error) {
                // fall through
            }
        }
        const opened = window.open(workerUrl, '_blank');
        if (opened) {
            try {
                opened.opener = null;
            } catch (error) {
                // ignore
            }
        }
        return Boolean(opened);
    };

    const clickElementLikeUser = (element) => {
        const target = getClickableElement(element);
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'].forEach((type) => {
            target.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX,
                clientY,
            }));
        });
        target.click?.();
    };

    const continueBatchTask = async () => {
        const task = getStoredJson(BATCH_TASK_KEY, null);
        if (!task?.items?.length || !['like', 'favorite'].includes(task.action)) return;

        const currentItem = task.items[task.index];
        if (!currentItem) {
            const done = task.results?.filter((item) => item.status === 'done').length || 0;
            const failed = task.results?.filter((item) => item.status !== 'done').length || 0;
            clearBatchTask();
            setStoredJson(BATCH_RESULT_KEY, {
                action: task.action,
                results: task.results || [],
                finishedAt: Date.now(),
            });
            showToast(`${getBatchActionLabel(task.action)}完成：成功 ${done} 个，失败 ${failed} 个。可以关闭这个工作页。`, 8000);
            return;
        }

        if (!isBatchWorkerPage()) return;

        const currentPage = canonicalizeDouyinUrl(window.location.href, ['video', 'note']);
        if (!currentPage || currentPage.id !== currentItem.id || currentPage.type !== currentItem.type) {
            showToast(`正在打开第 ${task.index + 1}/${task.items.length} 个作品...`, 1600);
            await sleep(400);
            openBatchTarget(currentItem);
            return;
        }

        showToast(`正在处理第 ${task.index + 1}/${task.items.length} 个：${getCleanText(currentItem.title, 30)}`, 1800);
        const button = await waitForBatchButton(task.action);
        const latestTask = getStoredJson(BATCH_TASK_KEY, null);
        if (!latestTask || latestTask.startedAt !== task.startedAt || latestTask.index !== task.index) {
            return;
        }

        const result = {
            ...currentItem,
            status: 'failed',
            message: '未找到已激活的按钮，可能当前作品未喜欢/收藏，或页面结构发生变化',
            details: {
                currentUrl: window.location.href,
                currentPage,
            },
            time: Date.now(),
        };

        if (button) {
            try {
                button.scrollIntoView({block: 'center', inline: 'center'});
                await sleep(250);
                clickElementLikeUser(button);
                await sleep(1600);
                if (findBatchActionButton(task.action)) {
                    result.status = 'failed';
                    result.message = '已点击，但按钮仍显示为激活状态，可能页面拦截或识别到了错误按钮';
                } else {
                    result.status = 'done';
                    result.message = '已点击取消';
                    result.details = {
                        currentUrl: window.location.href,
                        clicked: getElementBrief(button),
                    };
                }
            } catch (error) {
                result.message = error?.message || '点击失败';
            }
        }

        const nextTask = {
            ...task,
            index: task.index + 1,
            results: [...(task.results || []), result],
        };
        setStoredJson(BATCH_TASK_KEY, nextTask);
        await sleep(650);
        continueBatchTask();
    };

    const startBatchCancel = async (action) => {
        forceHideMenu();
        await autoScrollIfNeeded();
        const items = collectLinks(['video', 'note']);
        if (!items.length) {
            showToast('没有提取到作品。可以先进入喜欢/收藏列表并滚动加载作品后再试。');
            return;
        }

        const selected = await showWorkSelectionModal(items, getBatchActionLabel(action));
        if (!selected) return;
        if (!selected.length) {
            showToast('没有选择任何作品');
            return;
        }

        const confirmedText = action === 'like'
            ? `将通过抖音网页接口取消喜欢 ${selected.length} 个作品。\n\n不会逐个打开作品页，请确认这些都是你要处理的作品。`
            : `将优先通过抖音网页接口取消收藏 ${selected.length} 个作品。\n\n如果接口无法确认已取消，会提示改用新标签页逐个打开作品并模拟点击。请确认这些都是你要处理的作品。`;
        const confirmed = window.confirm(confirmedText);
        if (!confirmed) return;

        if (action === 'like') {
            forceHideMenu();
            clearBatchTask();
            const result = await cancelLikesByApi(selected);
            if (result.failed > 0) {
                const fallback = window.confirm(`接口取消喜欢失败 ${result.failed} 个。\n\n是否改用新标签页逐个打开作品并模拟点击取消喜欢？`);
                if (fallback) startBatchClickFallback('like', result.results.filter((item) => item.status !== 'done'));
            }
            return;
        }

        if (action === 'favorite') {
            forceHideMenu();
            clearBatchTask();
            const result = await cancelFavoritesByApi(selected);
            if (result.failed > 0) {
                const fallback = window.confirm(`接口取消收藏失败 ${result.failed} 个。\n\n是否改用新标签页逐个打开作品并模拟点击取消收藏？`);
                if (fallback) startBatchClickFallback('favorite', result.results.filter((item) => item.status !== 'done'));
            }
            return;
        }

        setStoredJson(BATCH_TASK_KEY, {
            action,
            items: selected.map((item) => ({
                type: item.type,
                id: item.id,
                url: item.url,
                title: item.title,
                cover: item.cover,
                label: item.label,
            })),
            index: 0,
            results: [],
            startedAt: Date.now(),
        });
        forceHideMenu();
        const opened = openBatchWorker(selected[0]);
        if (opened) {
            showToast(`已在新标签页启动${getBatchActionLabel(action)}任务。当前页面可以继续使用。`, 5000);
        } else {
            showToast('新标签页被浏览器拦截了。请允许此网站弹出窗口后重试。', 7000);
        }
    };

    function startBatchClickFallback(action, selected) {
        if (!selected?.length) return;
        setStoredJson(BATCH_TASK_KEY, {
            action,
            items: selected.map((item) => ({
                type: item.type,
                id: item.id,
                url: item.url,
                title: item.title,
                cover: item.cover,
                label: item.label,
            })),
            index: 0,
            results: [],
            startedAt: Date.now(),
        });
        forceHideMenu();
        const opened = openBatchWorker(selected[0]);
        if (opened) {
            showToast(`已在新标签页启动${getBatchActionLabel(action)}点击兜底任务。`, 5000);
        } else {
            showToast('新标签页被浏览器拦截了。请允许此网站弹出窗口后重试。', 7000);
        }
    }

    const saveSettingsFromModal = (overlay) => {
        const autoScroll = overlay.querySelector('[name="autoScroll"]').checked;
        const maxScrollCount = Math.max(1, Math.min(300, Number(overlay.querySelector('[name="maxScrollCount"]').value || 20)));
        const confirmBeforeCopy = overlay.querySelector('[name="confirmBeforeCopy"]').checked;
        const keepMenuVisible = overlay.querySelector('[name="keepMenuVisible"]').checked;
        const keepQuery = overlay.querySelector('[name="keepQuery"]').checked;

        Object.assign(config, {
            autoScroll,
            maxScrollCount,
            confirmBeforeCopy,
            keepMenuVisible,
            keepQuery,
        });

        Object.entries(config).forEach(([key, value]) => writeValue(key, value));
        showToast('设置已保存');
    };

    const showSettings = () => {
        const overlay = document.createElement('div');
        overlay.className = 'dy-url-overlay';
        overlay.innerHTML = `
            <div class="dy-url-modal dy-url-settings-modal" role="dialog" aria-modal="true">
                <div class="dy-url-modal-header">
                    <div>
                        <div class="dy-url-modal-title">Douyin URL Extractor 设置</div>
                        <div class="dy-url-modal-subtitle">设置保存后立即生效</div>
                    </div>
                    <button class="dy-url-icon-button" type="button" data-action="close" aria-label="关闭">×</button>
                </div>
                <div class="dy-url-settings">
                    <label class="dy-url-setting-row">
                        <span>
                            <strong>自动滚动页面</strong>
                            <small>提取前自动向下滚动，加载更多已登录可见内容。</small>
                        </span>
                        <input type="checkbox" name="autoScroll" ${config.autoScroll ? 'checked' : ''}>
                    </label>
                    <label class="dy-url-setting-row">
                        <span>
                            <strong>自动滚动次数</strong>
                            <small>建议 10 到 50，太大时页面加载会更久。</small>
                        </span>
                        <input type="number" name="maxScrollCount" min="1" max="300" value="${Number(config.maxScrollCount || 20)}">
                    </label>
                    <label class="dy-url-setting-row">
                        <span>
                            <strong>复制前手动选择</strong>
                            <small>开启后会先弹出列表，勾选需要复制的链接。</small>
                        </span>
                        <input type="checkbox" name="confirmBeforeCopy" ${config.confirmBeforeCopy ? 'checked' : ''}>
                    </label>
                    <label class="dy-url-setting-row">
                        <span>
                            <strong>菜单保持显示</strong>
                            <small>悬浮菜单打开后不因鼠标移开而自动隐藏。</small>
                        </span>
                        <input type="checkbox" name="keepMenuVisible" ${config.keepMenuVisible ? 'checked' : ''}>
                    </label>
                    <label class="dy-url-setting-row">
                        <span>
                            <strong>保留链接参数</strong>
                            <small>默认输出干净链接；开启后尽量保留原始查询参数。</small>
                        </span>
                        <input type="checkbox" name="keepQuery" ${config.keepQuery ? 'checked' : ''}>
                    </label>
                </div>
                <div class="dy-url-modal-footer">
                    <button class="dy-url-secondary-button" type="button" data-action="close">取消</button>
                    <button class="dy-url-primary-button" type="button" data-action="save">保存设置</button>
                </div>
            </div>
        `;

        overlay.addEventListener('click', (event) => {
            const action = event.target?.dataset?.action;
            if (event.target === overlay || action === 'close') {
                overlay.remove();
                return;
            }
            if (action === 'save') {
                saveSettingsFromModal(overlay);
                overlay.remove();
            }
        });

        document.body.appendChild(overlay);
    };

    const createMenuItem = ({ icon, title, desc, action }) => {
        const item = document.createElement('button');
        item.className = 'dy-url-menu-item';
        item.type = 'button';
        item.innerHTML = `
            <span class="dy-url-menu-icon">${escapeHtml(icon)}</span>
            <span class="dy-url-menu-text">
                <strong>${escapeHtml(title)}</strong>
                <small>${escapeHtml(desc)}</small>
            </span>
        `;
        item.addEventListener('click', () => {
            forceHideMenu();
            setTimeout(action, 0);
        });
        return item;
    };

    const injectStyles = () => {
        if (document.querySelector('#dy-url-extractor-style')) return;

        const style = document.createElement('style');
        style.id = 'dy-url-extractor-style';
        style.textContent = `
            .dy-url-launcher {
                position: fixed;
                left: 24px;
                bottom: 64px;
                width: 48px;
                height: 48px;
                border: 0;
                border-radius: 12px;
                background: #111;
                color: #fff;
                font-size: 22px;
                font-weight: 700;
                cursor: pointer;
                z-index: 2147483600;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
            }

            .dy-url-launcher::after {
                content: "";
                position: absolute;
                right: -3px;
                top: 9px;
                width: 6px;
                height: 30px;
                border-radius: 999px;
                background: #fe2c55;
                box-shadow: -6px 0 0 #25f4ee;
            }

            .dy-url-menu {
                position: fixed;
                left: 24px;
                bottom: 120px;
                width: 292px;
                max-width: calc(100vw - 48px);
                background: #fff;
                color: #171717;
                border: 1px solid rgba(0, 0, 0, 0.08);
                border-radius: 14px;
                box-shadow: 0 18px 44px rgba(0, 0, 0, 0.22);
                max-height: calc(100vh - 144px);
                overflow-y: auto;
                overscroll-behavior: contain;
                z-index: 2147483599;
                opacity: 0;
                transform: translateY(8px) scale(0.98);
                pointer-events: none;
                transition: opacity 160ms ease, transform 160ms ease;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }

            .dy-url-menu.dy-url-menu-open {
                opacity: 1;
                transform: translateY(0) scale(1);
                pointer-events: auto;
            }

            .dy-url-menu-header {
                padding: 14px 16px 10px;
                border-bottom: 1px solid #f0f0f0;
            }

            .dy-url-menu-header strong {
                display: block;
                font-size: 15px;
                line-height: 1.2;
            }

            .dy-url-menu-header small {
                display: block;
                margin-top: 4px;
                color: #737373;
                font-size: 12px;
                line-height: 1.4;
            }

            .dy-url-menu-item {
                display: flex;
                width: 100%;
                gap: 12px;
                align-items: flex-start;
                padding: 13px 16px;
                border: 0;
                border-bottom: 1px solid #f4f4f4;
                background: #fff;
                color: inherit;
                text-align: left;
                cursor: pointer;
            }

            .dy-url-menu-item:hover {
                background: #f7f7f7;
            }

            .dy-url-menu-icon {
                flex: 0 0 26px;
                width: 26px;
                height: 26px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 8px;
                background: #111;
                color: #fff;
                font-size: 14px;
            }

            .dy-url-menu-text {
                min-width: 0;
            }

            .dy-url-menu-text strong {
                display: block;
                font-size: 14px;
                line-height: 1.25;
                font-weight: 650;
            }

            .dy-url-menu-text small {
                display: block;
                margin-top: 3px;
                color: #737373;
                font-size: 12px;
                line-height: 1.35;
            }

            .dy-url-toast {
                position: fixed;
                left: 50%;
                bottom: 116px;
                max-width: min(560px, calc(100vw - 40px));
                transform: translate(-50%, 8px);
                padding: 10px 14px;
                border-radius: 10px;
                background: rgba(17, 17, 17, 0.92);
                color: #fff;
                font-size: 14px;
                line-height: 1.45;
                opacity: 0;
                transition: opacity 180ms ease, transform 180ms ease;
                z-index: 2147483647;
                pointer-events: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                white-space: pre-wrap;
                text-align: center;
            }

            .dy-url-toast.dy-url-toast-visible {
                opacity: 1;
                transform: translate(-50%, 0);
            }

            .dy-url-overlay {
                position: fixed;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                background: rgba(0, 0, 0, 0.42);
                z-index: 2147483646;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }

            .dy-url-modal {
                width: min(720px, 100%);
                max-height: min(720px, calc(100vh - 48px));
                display: flex;
                flex-direction: column;
                background: #fff;
                color: #171717;
                border-radius: 14px;
                overflow: hidden;
                box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
            }

            .dy-url-settings-modal {
                width: min(620px, 100%);
            }

            .dy-url-modal-header {
                display: flex;
                justify-content: space-between;
                gap: 16px;
                padding: 18px 20px 14px;
                border-bottom: 1px solid #eeeeee;
            }

            .dy-url-modal-title {
                font-size: 17px;
                font-weight: 700;
                line-height: 1.25;
            }

            .dy-url-modal-subtitle {
                margin-top: 4px;
                color: #737373;
                font-size: 13px;
                line-height: 1.4;
            }

            .dy-url-icon-button {
                width: 32px;
                height: 32px;
                border: 0;
                border-radius: 8px;
                background: #f2f2f2;
                color: #333;
                cursor: pointer;
                font-size: 22px;
                line-height: 1;
            }

            .dy-url-list {
                overflow: auto;
                padding: 8px 0;
            }

            .dy-url-work-list {
                overflow: auto;
                padding: 8px 0;
            }

            .dy-url-list-row {
                display: flex;
                gap: 12px;
                align-items: flex-start;
                padding: 12px 20px;
                cursor: pointer;
            }

            .dy-url-list-row:hover {
                background: #f7f7f7;
            }

            .dy-url-list-row input {
                margin-top: 3px;
            }

            .dy-url-work-row {
                display: grid;
                grid-template-columns: auto 72px minmax(0, 1fr);
                gap: 12px;
                align-items: center;
                padding: 12px 20px;
                cursor: pointer;
            }

            .dy-url-work-row:hover {
                background: #f7f7f7;
            }

            .dy-url-work-cover {
                width: 72px;
                height: 96px;
                border-radius: 8px;
                background: #eeeeee;
                object-fit: cover;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                color: #777;
                font-size: 12px;
                overflow: hidden;
            }

            .dy-url-row-content {
                min-width: 0;
            }

            .dy-url-row-title {
                display: block;
                color: #222;
                font-size: 14px;
                font-weight: 620;
                line-height: 1.35;
                overflow-wrap: anywhere;
            }

            .dy-url-row-meta {
                display: block;
                margin-top: 4px;
                color: #777;
                font-size: 12px;
                line-height: 1.4;
                overflow-wrap: anywhere;
            }

            .dy-url-settings {
                padding: 8px 20px 14px;
                overflow: auto;
            }

            .dy-url-setting-row {
                display: flex;
                justify-content: space-between;
                gap: 16px;
                align-items: center;
                padding: 14px 0;
                border-bottom: 1px solid #f0f0f0;
            }

            .dy-url-setting-row strong {
                display: block;
                font-size: 14px;
                line-height: 1.35;
            }

            .dy-url-setting-row small {
                display: block;
                margin-top: 4px;
                color: #777;
                font-size: 12px;
                line-height: 1.45;
            }

            .dy-url-setting-row input[type="number"] {
                width: 88px;
                height: 34px;
                padding: 0 8px;
                border: 1px solid #d5d5d5;
                border-radius: 8px;
            }

            .dy-url-modal-footer {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
                padding: 14px 20px 18px;
                border-top: 1px solid #eeeeee;
                background: #fff;
            }

            .dy-url-primary-button,
            .dy-url-secondary-button {
                height: 36px;
                padding: 0 14px;
                border-radius: 9px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 620;
            }

            .dy-url-primary-button {
                border: 1px solid #111;
                background: #111;
                color: #fff;
            }

            .dy-url-secondary-button {
                border: 1px solid #d7d7d7;
                background: #fff;
                color: #222;
            }
        `;
        document.head.appendChild(style);
    };

    let hideTimer = null;
    let menuElement = null;

    const hideMenu = () => {
        if (config.keepMenuVisible) return;
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => {
            menuElement?.classList.remove('dy-url-menu-open');
        }, 120);
    };

    const showMenu = () => {
        window.clearTimeout(hideTimer);
        menuElement?.classList.add('dy-url-menu-open');
    };

    const buildMenu = () => {
        menuElement = document.createElement('div');
        menuElement.className = 'dy-url-menu';
        menuElement.innerHTML = `
            <div class="dy-url-menu-header">
                <strong>Douyin URL Extractor</strong>
                <small>提取当前抖音页面已加载的链接</small>
            </div>
        `;

        const actions = [
            {
                icon: '作',
                title: '提取作品链接',
                desc: '提取视频和图文作品链接',
                action: () => extractAndCopy(['video', 'note']),
            },
            {
                icon: '名',
                title: '提取作品链接+名称',
                desc: '每行输出作品名称和对应链接',
                action: () => extractAndCopy(['video', 'note'], {includeTitle: true}),
            },
            {
                icon: '赞',
                title: '批量取消喜欢',
                desc: '先选择作品，再通过接口批量取消喜欢',
                action: () => startBatchCancel('like'),
            },
            {
                icon: '藏',
                title: '批量取消收藏',
                desc: '先选择作品，再通过接口批量取消收藏',
                action: () => startBatchCancel('favorite'),
            },
            {
                icon: '停',
                title: '停止批量任务',
                desc: '中断正在进行的取消喜欢/收藏队列',
                action: stopBatchTask,
            },
            {
                icon: '设',
                title: '修改脚本设置',
                desc: '自动滚动、复制前选择、保留参数等',
                action: showSettings,
            },
        ];

        actions.forEach((action) => menuElement.appendChild(createMenuItem(action)));

        menuElement.addEventListener('mouseenter', showMenu);
        menuElement.addEventListener('mouseleave', hideMenu);

        return menuElement;
    };

    const buildLauncher = () => {
        const launcher = document.createElement('button');
        launcher.className = 'dy-url-launcher';
        launcher.type = 'button';
        launcher.textContent = '抖';
        launcher.title = 'Douyin URL Extractor';
        launcher.addEventListener('mouseenter', showMenu);
        launcher.addEventListener('mouseleave', hideMenu);
        launcher.addEventListener('click', () => {
            if (menuElement?.classList.contains('dy-url-menu-open')) {
                menuElement.classList.remove('dy-url-menu-open');
            } else {
                showMenu();
            }
        });
        return launcher;
    };

    const registerCommands = () => {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('提取作品链接', () => extractAndCopy(['video', 'note']));
        GM_registerMenuCommand('提取作品链接+名称', () => extractAndCopy(['video', 'note'], {includeTitle: true}));
        GM_registerMenuCommand('批量取消喜欢', () => startBatchCancel('like'));
        GM_registerMenuCommand('批量取消收藏', () => startBatchCancel('favorite'));
        GM_registerMenuCommand('停止批量任务', stopBatchTask);
        GM_registerMenuCommand('修改脚本设置', showSettings);
    };

    const init = () => {
        if (!document.body) {
            window.setTimeout(init, 200);
            return;
        }
        markBatchWorkerPage();
        if (document.querySelector('.dy-url-launcher')) return;

        injectStyles();
        document.body.appendChild(buildLauncher());
        document.body.appendChild(buildMenu());
        registerCommands();
        if (isBatchWorkerPage()) {
            setTimeout(continueBatchTask, 800);
        }
    };

    init();
})();
