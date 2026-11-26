#!/usr/bin/env node
/**
 * 🔥 CZ Fire — ponte de dados (sm) para listas prontas do CZ.
 *
 *  1. Lê o indice.txt de cada base (filmes e canais): as linhas "base: <id> <url>" viram o dicionário de servidores
 *     e qualquer outro arquivo citado (.txt / .json / .m3u) entra na fila.
 *  2. Filmes: filmes-A.txt … filmes-Z.txt e filmes-%23.txt (letra #), além do que o índice citar.
 *  3. Cada arquivo vira itens no nosso formato (name, url, mirrors, group, title, year, serie, season, episode).
 *  4. A categoria sai do nome do arquivo (filmes, series, animes, doramas, novelas, novelinhas, kids, canais);
 *     o que não reconhecer vai para "outros". A organização fina fica no Sidechain.
 *  5. Publica listas/<categoria>.json (partes de até 35 MB: x.json, x-2.json…) e listas/resumo.json.
 *     Também grava listas/descoberta.md: o que o índice tem e 5 linhas de amostra de cada arquivo (para ajustar o leitor).
 *
 *   node tools/fire.mjs                     faz
 *   node tools/fire.mjs --simular           só mostra
 *   FIRE_FILMES=http://… FIRE_CANAIS=http://…  (troca as bases, usado nos testes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILMES_BASE = process.env.FIRE_FILMES || 'https://filmes-saimo.pages.dev';
const CANAIS_BASE = process.env.FIRE_CANAIS || 'https://canais-saimo.pages.dev';
const PROXY_URL = process.env.FIRE_PROXY || 'https://play.saimotv.com/api/proxy';
const SIMULAR = process.argv.includes('--simular');
const SAIDA = path.join(RAIZ, 'listas');
const LIMITE = 35 * 1024 * 1024;
const LETRAS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

const CATEGORIAS = [
    ['novelinhas', /novelinh/i], ['novelas', /novela/i], ['doramas', /dorama|k-?drama/i], ['animes', /anime/i],
    ['kids', /kids|infantil|desenho|crian/i], ['series', /s[eé]rie|series|tv-?show/i], ['filmes', /filme|movie/i],
    ['canais', /canal|canais|channel|tv|live|m3u/i]
];
export function categoriaDe(arquivo, padrao) {
    const nome = String(arquivo).split('/').pop();
    for (const [cat, re] of CATEGORIAS) if (re.test(nome)) return cat;
    return padrao || 'outros';
}

async function baixar(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (cz-fire)' } });
            if (r.status === 404) return null;
            if (r.ok) return await r.text();
        } catch (e) { /* tenta de novo */ }
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
    return null;
}

export function lerIndice(txt) {
    const bases = {}, arquivos = [], outras = [];
    for (const l of String(txt || '').split(/\r?\n/)) {
        const s = l.trim(); if (!s) continue;
        if (s.startsWith('base:')) { const [, id, url] = s.split(/\s+/); if (id && url) bases[id] = url.endsWith('/') ? url : url + '/'; continue; }
        const achados = s.match(/[\w%#./-]+\.(?:txt|json|m3u8?)\b/gi);
        if (achados) achados.forEach(a => arquivos.push(a.replace(/^\.?\//, '')));
        else outras.push(s);
    }
    return { bases, arquivos: [...new Set(arquivos)], outras };
}

export function resolverLink(bruto, bases) {
    const s = String(bruto || '').trim();
    if (!s) return null;
    if (/^(https?|magnet):/i.test(s)) return s;
    const idx = s.indexOf(':'); if (idx === -1) return null;
    const base = bases[s.slice(0, idx)], resto = s.slice(idx + 1);
    if (!base || !resto) return null;
    return resto.includes('.') ? base + resto : base + resto + '.mp4';
}

export function montarUrlCanal(rawUrl, referer = '') {
    if (!referer && !rawUrl.includes('s25-cloudfront-net.lat')) return rawUrl;
    const ref = referer || 'https://ww0.embedtv.cc/';
    return `${PROXY_URL}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(ref)}&format=m3u8`;
}

/** "Nome (2020)" → { titulo, ano };  "Série S01E02" / "Série T1 E2" / "Série 1x02" → episódio */
export function analisarTitulo(t) {
    let titulo = String(t).trim(), ano;
    const mAno = titulo.match(/\s*[([](19\d\d|20\d\d)[)\]]\s*$/);
    if (mAno) { ano = +mAno[1]; titulo = titulo.slice(0, mAno.index).trim(); }
    const mEp = titulo.match(/^(.*?)[\s._-]*(?:S(\d{1,2})\s*E(\d{1,4})|T(\d{1,2})\s*E(\d{1,4})|(\d{1,2})x(\d{1,4}))\b\s*[-:–]?\s*(.*)$/i);
    if (mEp && mEp[1].trim()) {
        return { serie: mEp[1].trim(), temporada: +(mEp[2] || mEp[4] || mEp[6]), episodio: +(mEp[3] || mEp[5] || mEp[7]), nomeEp: mEp[8] || '', ano };
    }
    return { titulo, ano };
}

function item(cat, tituloBruto, urls, extra = {}) {
    const a = analisarTitulo(tituloBruto);
    const o = { name: String(tituloBruto).trim(), url: urls[0] };
    if (urls.length > 1) o.mirrors = urls.slice(1);
    o.group = extra.group || NOME_GRUPO[cat] || 'Variados';
    if (extra.logo) o.logo = extra.logo;
    if (cat !== 'canais') {
        if (a.serie) { o.title = `${a.serie} S${String(a.temporada).padStart(2, '0')}E${String(a.episodio).padStart(2, '0')}${a.nomeEp ? ' ' + a.nomeEp : ''}`; o.serie = a.serie; o.season = a.temporada; o.episode = a.episodio; }
        else o.title = a.titulo;
        if (a.ano) o.year = a.ano;
    }
    return o;
}
const NOME_GRUPO = { filmes: 'Filmes', series: 'Séries', animes: 'Animes', doramas: 'Doramas', novelas: 'Novelas', novelinhas: 'Novelinhas', kids: 'Kids', canais: 'Canais', outros: 'Variados' };

/** formato de texto do Saimo: título<TAB>links (links separados por vírgula, "rótulo=links" aceito) */
export function lerTexto(txt, cat, bases) {
    const out = [];
    for (const linha of String(txt).split(/\r?\n/)) {
        if (!linha.trim() || linha.startsWith('#')) continue;
        const cols = linha.split('\t');
        const title = cols[0] && cols[0].trim(); if (!title) continue;
        const urls = [];
        let referer = '', logo = '', grupo = '';
        for (let i = 1; i < cols.length; i++) {
            const c = cols[i].trim(); if (!c) continue;
            const m = c.match(/^(referer|ref|logo|group|grupo)=(.*)$/i);
            if (m) { const k = m[1].toLowerCase(); if (k.startsWith('ref')) referer = m[2]; else if (k === 'logo') logo = m[2]; else grupo = m[2]; continue; }
            const parte = c.includes('=') ? c.split('=').slice(1).join('=') : c;
            for (const raw of parte.split(',')) {
                let u = resolverLink(raw, bases);
                if (!u || u.includes('/api/stream')) continue;
                if (cat === 'canais') u = montarUrlCanal(u, referer);
                if (!urls.includes(u)) urls.push(u);
            }
        }
        if (urls.length) out.push(item(cat, title, urls, { logo, group: grupo }));
    }
    return out;
}

export function lerM3U(txt, cat) {
    const out = []; let info = null;
    for (const l of String(txt).split(/\r?\n/)) {
        const s = l.trim(); if (!s) continue;
        if (s.startsWith('#EXTINF')) {
            const at = (k) => (s.match(new RegExp(k + '="([^"]*)"', 'i')) || [])[1] || '';
            info = { nome: s.slice(s.lastIndexOf(',') + 1).trim(), logo: at('tvg-logo'), grupo: at('group-title'), referer: '' };
        } else if (/^#EXTVLCOPT:http-referr?er=/i.test(s) && info) info.referer = s.split('=').slice(1).join('=');
        else if (!s.startsWith('#') && info) {
            const u = cat === 'canais' ? montarUrlCanal(s, info.referer) : s;
            out.push(item(cat, info.nome || s, [u], { logo: info.logo, group: info.grupo })); info = null;
        }
    }
    return out;
}

export function lerJSON(txt, cat, bases) {
    let d; try { d = JSON.parse(txt); } catch (e) { return []; }
    const lista = Array.isArray(d) ? d : (d.items || d.canais || d.channels || d.filmes || d.data || Object.values(d).find(Array.isArray) || []);
    const out = [];
    for (const o of lista) {
        if (!o || typeof o !== 'object') continue;
        const nome = o.title || o.name || o.nome || o.titulo; if (!nome) continue;
        const brutos = [].concat(o.url || o.link || o.stream || [], o.mirrors || o.links || []);
        const urls = [];
        for (const raw of brutos) { let u = resolverLink(typeof raw === 'string' ? raw : raw && raw.url, bases); if (!u) continue; if (cat === 'canais') u = montarUrlCanal(u, o.referer || ''); if (!urls.includes(u)) urls.push(u); }
        if (urls.length) out.push(item(cat, nome, urls, { logo: o.logo || o.thumb || o.poster, group: o.group || o.category || o.categoria }));
    }
    return out;
}

export function lerArquivo(nome, txt, cat, bases) {
    const t = String(txt || '').replace(/^﻿/, '');
    if (/^\s*#EXTM3U/.test(t)) return lerM3U(t, cat);
    if (/^\s*[[{]/.test(t)) return lerJSON(t, cat, bases);
    return lerTexto(t, cat, bases);
}

function gravarCategoria(cat, itens, gravados) {
    // partes de até 35 MB, JSON compacto
    const partes = []; let atual = [], tam = 2;
    for (const it of itens) {
        const s = JSON.stringify(it).length + 1;
        if (atual.length && tam + s > LIMITE) { partes.push(atual); atual = []; tam = 2; }
        atual.push(it); tam += s;
    }
    partes.push(atual);
    partes.forEach((p, i) => {
        const arq = `${cat}${i ? '-' + (i + 1) : ''}.json`;
        gravados.add(arq);
        if (!SIMULAR) fs.writeFileSync(path.join(SAIDA, arq), JSON.stringify(p));
    });
    return partes.length;
}


/** 🔎 procura no site do Saimo de onde vêm séries, animes, doramas… (vai para a descoberta) */
async function explorar(desc) {
    desc.push('## 🔎 Exploração do site', '');
    const scripts = new Set();
    for (const pg of ['https://saimo-tv.com.br/movies', 'https://saimo-tv.com.br/', 'https://saimo-tv.com.br/tv']) {
        const h = await baixar(pg); if (!h) { desc.push(`- ${pg} não abriu`); continue; }
        for (const m of h.matchAll(/<script[^>]+src="([^"]+)"/gi)) scripts.add(new URL(m[1], pg).href);
        for (const m of h.matchAll(/<link[^>]+href="([^"]+\.js)"/gi)) scripts.add(new URL(m[1], pg).href);
    }
    const fila = [...scripts], feitos = new Set(), achados = new Set(), trechos = [];
    while (fila.length && feitos.size < 60) {
        const u = fila.shift(); if (feitos.has(u)) continue; feitos.add(u);
        const js = await baixar(u); if (!js) continue;
        if (/indice\.txt|VodCatalog|novelinhas/.test(js) && !SIMULAR) { fs.mkdirSync(path.join(SAIDA, 'bruto'), { recursive: true }); fs.writeFileSync(path.join(SAIDA, 'bruto', u.split('/').pop()), js); }
        for (const m of js.matchAll(/["'`](\.?\.?\/?[\w./-]+\.js)["'`]/g)) { try { const v = new URL(m[1], u).href; if (v.includes('saimo') && !feitos.has(v)) fila.push(v); } catch (e) {} }
        for (const m of js.matchAll(/https?:\/\/[\w.-]+\.(?:pages\.dev|workers\.dev|saimotv\.com|saimo-tv\.com\.br)[\w./%?=&-]*/g)) achados.add(m[0]);
        for (const m of js.matchAll(/["'`][\w${}%.\/-]*\.(?:txt|json|m3u8?)["'`]/g)) achados.add(m[0]);
        for (const re of [/filmes-/g, /indice\.txt/g, /dorama/gi, /novela/gi, /anime/gi, /s[eé]ries?-/gi, /kids/gi]) {
            let n = 0; for (const m of js.matchAll(re)) { if (n++ >= 3) break; trechos.push(`[${u.split('/').pop()}] …${js.slice(Math.max(0, m.index - 160), m.index + 200).replace(/\s+/g, ' ')}…`); }
        }
    }
    desc.push(`Scripts lidos: ${feitos.size}`, '', 'Endereços e arquivos citados:', '```', ...[...achados].slice(0, 200), '```', '', 'Trechos:', '```', ...trechos.slice(0, 80), '```', '');
    const ok = [];
    for (const n of ['categorias.txt', 'busca.txt', 'generos.txt', 'fichas.txt', 'detalhes.txt', 'novelinhas.txt', 'destaques.txt', 'marcas.txt', 'series-A.txt', 'series-A-1.txt', 'redeflix/links-animes.txt', 'redeflix/links-doramas.txt', 'animes.txt', 'doramas.txt', 'novelas.txt', 'kids.txt']) {
        const t = await baixar(FILMES_BASE + '/' + n);
        if (t && !/^\s*<!doctype html/i.test(t)) { ok.push(`${n} → ${t.split(/\r?\n/).filter(Boolean).slice(0, 6).join(' ⏎ ').slice(0, 900)}`); if (!SIMULAR) { fs.mkdirSync(path.join(SAIDA, 'bruto'), { recursive: true }); fs.writeFileSync(path.join(SAIDA, 'bruto', n.replace(/\//g, '_')), t.slice(0, 200000)); } }
    }
    desc.push('Nomes testados que abriram:', '```', ...(ok.length ? ok : ['(nenhum)']), '```', '');
}

// ───────────── leitura do acervo do Saimo (formato documentado no próprio app deles) ─────────────
const CAT_DE = { anime: 'animes', dorama: 'doramas', novela: 'novelas', kids: 'kids' };
const linhas = (t) => String(t || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
const desfazHtml = (s) => String(s).replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const semAno = (t) => String(t).replace(/\s*\((19|20)\d\d\)\s*$/, '').trim();

/** "tipo<TAB>título<TAB>…" → Map("f|título" → colunas) */
export function tabelaPorTitulo(txt) {
    const m = new Map();
    for (const l of linhas(txt)) { const c = l.split('\t'); if (c.length >= 3) m.set(c[0] + '|' + c[1], c.slice(2)); }
    return m;
}
/** a categoria do título: anime, dorama, novela, kids ("anime,kids" fica em animes) ou a padrão */
export function categoriaDoTitulo(cats, tipo, titulo, padrao) {
    const c = cats.get(tipo + '|' + titulo) || cats.get(tipo + '|' + semAno(titulo));
    if (!c) return padrao;
    const lista = String(c[0] || '').split(',').map(s => s.trim());
    for (const k of ['anime', 'dorama', 'novela', 'kids']) if (lista.includes(k)) return CAT_DE[k];
    return padrao;
}
/** "18:228194" → tmdb do filme; "19:210750/1/1" → tmdb da série (os servidores do Saimo usam o id do TMDB no caminho) */
export function tmdbDoLink(raw) { const m = String(raw).match(/^\d+:(\d+)(?:[/.?]|$)/); return m ? m[1] : undefined; }

function enfeitar(o, tipo, titulo, aux) {
    const f = aux.fichas.get(tipo + '|' + titulo);
    if (f) {
        if (f[0] && /^\d+$/.test(f[0])) { o.tmdbId = f[0]; o.tmdbTipo = tipo === 'f' ? 'movie' : 'tv'; }
        if (f[1]) o.thumb = /^https?:/.test(f[1]) ? f[1] : aux.capaBase + f[1];
        if (f[2]) o.genre = f[2].split(',')[0];
    }
    const d = aux.detalhes.get(tipo + '|' + titulo);
    if (d) { if (+d[0] && !o.year) o.year = +d[0]; if (+d[1]) o.rating = +d[1]; if (d[2]) o.age = d[2]; }
    if (!o.genre) { const g = aux.generos.get(tipo + '|' + titulo); if (g && g[0]) o.genre = g[0].split(',')[0]; }
    return o;
}

/** filmes-X.txt: título<TAB>dub=links<TAB>leg=links */
export function lerFilmesSaimo(txt, bases, aux, porCat) {
    for (const l of linhas(txt)) {
        const cols = l.split('\t'), titulo = cols[0].trim(); if (!titulo) continue;
        const urls = [], auds = new Set(); let tmdb;
        for (const c of cols.slice(1)) {
            const rot = c.includes('=') ? c.split('=')[0] : 'dub';
            const parte = c.includes('=') ? c.split('=').slice(1).join('=') : c;
            for (const raw of parte.split(',')) {
                const u = resolverLink(raw, bases); if (!u || urls.includes(u)) continue;
                urls.push(u); auds.add(rot === 'leg' ? 'legendado' : 'dublado'); tmdb = tmdb || tmdbDoLink(raw.trim());
            }
        }
        if (!urls.length) continue;
        const cat = categoriaDoTitulo(aux.cats, 'f', titulo, 'filmes');
        const a = analisarTitulo(titulo);
        const o = { name: titulo, url: urls[0] };
        if (urls.length > 1) o.mirrors = urls.slice(1);
        o.group = NOME_GRUPO[cat]; o.title = a.titulo || titulo; if (a.ano) o.year = a.ano;
        o.audios = [...auds];
        if (tmdb) { o.tmdbId = tmdb; o.tmdbTipo = 'movie'; }
        (porCat[cat] = porCat[cat] || []).push(enfeitar(o, 'f', titulo, aux));
    }
}

/** o link do próprio Saimo (/api/stream, resolve na hora e toca) vai primeiro; os outros ficam de reserva */
export const ordenarLinks = (urls) => urls.filter(u => /\/api\/stream/.test(u)).concat(urls.filter(u => !/\/api\/stream/.test(u)));

/** blocos "@Título<TAB>ano<TAB>tmdb" seguidos de "temporada<TAB>episódio<TAB>dub|leg<TAB>link" */
export function lerEpisodiosSaimo(txt, bases, aux, porCat, catPadrao, infoSerie) {
    let atual = null;
    const fechar = () => {
        if (!atual) return;
        const cat = categoriaDoTitulo(aux.cats, 's', atual.titulo, catPadrao);
        for (const ep of atual.eps.values()) {
            ep.urls = ordenarLinks(ep.urls);
            const nome = `${atual.serie} S${String(ep.t).padStart(2, '0')}E${String(ep.e).padStart(2, '0')}`;
            const o = { name: nome, url: ep.urls[0] };
            if (ep.urls.length > 1) o.mirrors = ep.urls.slice(1);
            o.group = NOME_GRUPO[cat]; o.title = nome; o.serie = atual.serie; o.season = ep.t; o.episode = ep.e;
            if (atual.ano) o.year = atual.ano;
            o.audios = [...ep.auds];
            if (atual.tmdb) { o.tmdbId = atual.tmdb; o.tmdbTipo = 'tv'; }
            (porCat[cat] = porCat[cat] || []).push(enfeitar(o, 's', atual.titulo, aux));
        }
        atual = null;
    };
    for (const l of linhas(txt)) {
        if (l.startsWith('@')) {
            fechar();
            const c = l.slice(1).split('\t'), titulo = desfazHtml(c[0].trim()), info = infoSerie && infoSerie.get(titulo);
            const ano = +(c[1] || (info && info.ano) || 0) || undefined;
            atual = { titulo, serie: semAno(titulo), ano, tmdb: /^\d+$/.test(c[2] || '') ? c[2] : undefined, eps: new Map() };
            continue;
        }
        if (!atual) continue;
        const c = l.split('\t'); if (c.length < 4) continue;
        // a coluna de links pode trazer VÁRIOS, separados por vírgula (ex.: nixplay, dbonline e o /api/stream do Saimo): cada um vira um link
        const t = +c[0], e = +c[1]; if (!Number.isFinite(t) || !Number.isFinite(e)) continue;
        const us = c.slice(3).join(',').split(',').map(x => resolverLink(x, bases)).filter(Boolean); if (!us.length) continue;
        const k = t + '|' + e, ep = atual.eps.get(k) || { t, e, urls: [], auds: new Set() };
        for (const u of us) if (!ep.urls.includes(u)) ep.urls.push(u);
        ep.auds.add(c[2] === 'leg' ? 'legendado' : 'dublado');
        atual.tmdb = atual.tmdb || tmdbDoLink(String(c[3]).split(',')[0]);
        atual.eps.set(k, ep);
    }
    fechar();
}

/** novelinhas.txt: base + pasta + /episode-NNN.mp4 */
export function lerNovelinhas(txt, porCat) {
    let base = '';
    for (const l of String(txt || '').split(/\r?\n/)) {
        if (l.startsWith('base:')) { base = l.slice(5).trim(); if (!base.endsWith('/')) base += '/'; continue; }
        if (!l.trim() || l.startsWith('#')) continue;
        const [, titulo, pasta, neps, aud, capa, gens, sinopse] = l.split('\t');
        if (!titulo || !pasta || !+neps) continue;
        for (let e = 1; e <= +neps; e++) {
            const nome = `${titulo.trim()} S01E${String(e).padStart(2, '0')}`;
            const o = { name: nome, url: `${base}${pasta}/episode-${String(e).padStart(3, '0')}.mp4`, group: 'Novelinhas', title: nome, serie: titulo.trim(), season: 1, episode: e, audios: [aud === 'leg' ? 'legendado' : 'dublado'] };
            if (capa) o.thumb = capa; if (gens) o.genre = gens.split(',')[0]; if (sinopse) o.desc = sinopse;
            (porCat.novelinhas = porCat.novelinhas || []).push(o);
        }
    }
}

/** catalogo.txt dos canais: "chave: valor" (canal, logo, categoria, fonte, nome, referer, agente, chave) */
export function lerCatalogoCanais(txt) {
    const out = []; let c = null, f = null;
    const fechar = () => {
        if (!c || !c.fontes.length) { c = null; return; }
        const urls = c.fontes.map(x => montarUrlCanal(x.url, x.referer));
        const o = { name: c.nome, url: urls[0] };
        if (urls.length > 1) o.mirrors = urls.slice(1);
        o.group = c.categoria || 'Canais';
        if (c.logo) o.logo = c.logo;
        const h = {}, f0 = c.fontes[0];
        if (f0.agente) h['User-Agent'] = f0.agente;
        if (f0.referer && urls[0] === f0.url) h.Referer = f0.referer;
        if (Object.keys(h).length) o.headers = h;
        if (f0.chave) o.clearkey = f0.chave;
        out.push(o); c = null;
    };
    for (const l of String(txt || '').split(/\r?\n/)) {
        const s = l.trim(); if (!s || s.startsWith('#')) continue;
        const i = s.indexOf(':'); if (i < 1) continue;
        const k = s.slice(0, i).trim().toLowerCase(), v = s.slice(i + 1).trim();
        if (k === 'canal') { fechar(); c = { nome: v, fontes: [] }; f = null; }
        else if (!c) continue;
        else if (k === 'logo') c.logo = v;
        else if (k === 'categoria') c.categoria = v;
        else if (k === 'fonte') { f = { url: v }; c.fontes.push(f); }
        else if (f && (k === 'referer' || k === 'agente' || k === 'chave' || k === 'nome')) f[k] = v;
    }
    fechar();
    return out;
}

async function main() {
    const inicio = Date.now();
    const desc = ['# 🔥 CZ Fire — descoberta', '', `Gerado em ${new Date().toISOString()}`, ''];
    const porCat = {};
    const pegar = async (arq) => { const t = await baixar(`${FILMES_BASE}/${arq}`); return t && !/^\s*<!doctype html/i.test(t) ? t : null; };

    // índice: servidores + quantos filmes/séries por letra
    const indTxt = await pegar('indice.txt');
    if (!indTxt) { console.error('🛑 indice.txt não abriu — as listas antigas ficam.'); process.exit(1); }
    const bases = {}, letras = [];
    for (const l of indTxt.split(/\r?\n/)) {
        const s = l.trim(); if (!s) continue;
        if (s.startsWith('base:')) { const [, id, url] = s.split(/\s+/); if (id && url) bases[id] = url.endsWith('/') ? url : url + '/'; continue; }
        const c = l.split('\t'); if (c.length >= 3 && /^([A-Z#])$/.test(c[0].trim())) letras.push({ letra: c[0].trim(), filmes: +c[1] || 0, series: +c[2] || 0 });
    }
    const aux = { cats: tabelaPorTitulo(await pegar('categorias.txt')), fichas: new Map(), detalhes: tabelaPorTitulo(await pegar('detalhes.txt')), generos: tabelaPorTitulo(await pegar('generos.txt')), capaBase: 'https://image.tmdb.org/t/p/w342' };
    const fichasTxt = await pegar('fichas.txt');
    if (fichasTxt) { const m = fichasTxt.match(/^capa:\s*(\S+)/m); if (m) aux.capaBase = m[1]; aux.fichas = tabelaPorTitulo(fichasTxt.split(/\r?\n/).filter(l => !l.startsWith('capa:')).join('\n')); }
    desc.push(`Índice: ${letras.reduce((a, l) => a + l.filmes, 0)} filmes · ${letras.reduce((a, l) => a + l.series, 0)} séries`, '```', ...indTxt.split(/\r?\n/).filter(l => !l.startsWith('base:')).slice(0, 40), '```');
    desc.push(`Servidores: ${Object.keys(bases).length} · letras: ${letras.length} · categorias: ${aux.cats.size} · fichas: ${aux.fichas.size}`, '');

    for (const { letra, filmes, series } of letras) {
        const L = letra === '#' ? '%23' : letra;
        if (filmes) { const t = await pegar(`filmes-${L}.txt`); if (t) lerFilmesSaimo(t, bases, aux, porCat); else desc.push(`- ❌ filmes-${letra}.txt não abriu`); }
        if (series) {
            const lista = await pegar(`series-${L}.txt`); if (!lista) { desc.push(`- ❌ series-${letra}.txt não abriu`); continue; }
            const info = new Map(), pedacos = new Set();
            for (const l of linhas(lista)) { const c = l.split('\t'); info.set(c[0].trim(), { ano: c[1] }); if (c[2] !== undefined && c[2] !== '') pedacos.add(c[2].trim()); }
            for (const n of pedacos) { const t = await pegar(`series-${L}-${n}.txt`); if (t) lerEpisodiosSaimo(t, bases, aux, porCat, 'series', info); else desc.push(`- ❌ series-${letra}-${n}.txt não abriu`); }
        }
        console.log(`🔤 ${letra}`);
    }
    for (const [arq, cat] of [['redeflix/links-animes.txt', 'animes'], ['redeflix/links-doramas.txt', 'doramas']]) {
        const t = await pegar(arq); if (t) lerEpisodiosSaimo(t, bases, aux, porCat, cat, null); else desc.push(`- ❌ ${arq} não abriu`);
    }
    const nov = await pegar('novelinhas.txt'); if (nov) lerNovelinhas(nov, porCat); else desc.push('- ❌ novelinhas.txt não abriu');

    // canais: catalogo.txt (o que o app usa) ou canais.txt
    for (const arq of ['catalogo.txt', 'canais.txt']) {
        const t = await baixar(`${CANAIS_BASE}/${arq}`); if (!t || /^\s*<!doctype html/i.test(t)) continue;
        const itens = arq === 'catalogo.txt' ? lerCatalogoCanais(t) : lerArquivo(arq, t, 'canais', bases);
        desc.push(`### canais: ${arq} (${itens.length})`, '```', ...t.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).slice(0, 12).map(l => l.slice(0, 200)), '```', '');
        if (itens.length) { porCat.canais = itens; break; }
    }
    if (process.argv.includes('--explorar') || process.env.FIRE_EXPLORAR) await explorar(desc);

    // um episódio/filme repetido (mesmo nome) vira um só, juntando os links
    if (!SIMULAR) fs.mkdirSync(SAIDA, { recursive: true });
    const gravados = new Set(['resumo.json', 'descoberta.md']);
    const resumo = { geradoEm: new Date().toISOString(), categorias: {} };
    for (const [cat, bruto] of Object.entries(porCat)) {
        const m = new Map();
        for (const it of bruto) {
            const k = it.name.toLowerCase() + '|' + (it.tmdbId || ''), j = m.get(k);
            if (!j) { m.set(k, it); continue; }
            const todos = [j.url, ...(j.mirrors || []), it.url, ...(it.mirrors || [])].filter((u, i, a) => a.indexOf(u) === i);
            j.mirrors = todos.slice(1); j.audios = [...new Set([...(j.audios || []), ...(it.audios || [])])];
        }
        const itens = [...m.values()]; if (!itens.length) continue;
        itens.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
        resumo.categorias[cat] = { itens: itens.length, partes: gravarCategoria(cat, itens, gravados) };
    }
    const total = Object.values(resumo.categorias).reduce((s, c) => s + c.itens, 0);
    if (!total) { console.error('🛑 Nada veio das fontes — as listas antigas ficam como estão.'); process.exit(1); }
    if (!SIMULAR) {
        for (const f of fs.readdirSync(SAIDA)) if (!gravados.has(f) && /\.json$/.test(f)) fs.rmSync(path.join(SAIDA, f));
        fs.writeFileSync(path.join(SAIDA, 'resumo.json'), JSON.stringify(resumo, null, 1) + '\n');
        fs.writeFileSync(path.join(SAIDA, 'descoberta.md'), desc.join('\n') + '\n');
    }
    console.log(`🔥 CZ Fire: ${total} itens · ${Object.entries(resumo.categorias).map(([c, v]) => `${c} ${v.itens}`).join(' · ')} · ${Math.round((Date.now() - inicio) / 1000)}s${SIMULAR ? ' (simulação)' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
