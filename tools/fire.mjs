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
        for (const m of js.matchAll(/["'`](\.?\.?\/?[\w./-]+\.js)["'`]/g)) { try { const v = new URL(m[1], u).href; if (v.includes('saimo') && !feitos.has(v)) fila.push(v); } catch (e) {} }
        for (const m of js.matchAll(/https?:\/\/[\w.-]+\.(?:pages\.dev|workers\.dev|saimotv\.com|saimo-tv\.com\.br)[\w./%?=&-]*/g)) achados.add(m[0]);
        for (const m of js.matchAll(/["'`][\w${}%.\/-]*\.(?:txt|json|m3u8?)["'`]/g)) achados.add(m[0]);
        for (const re of [/filmes-/g, /indice\.txt/g, /dorama/gi, /novela/gi, /anime/gi, /s[eé]ries?-/gi, /kids/gi]) {
            let n = 0; for (const m of js.matchAll(re)) { if (n++ >= 3) break; trechos.push(`[${u.split('/').pop()}] …${js.slice(Math.max(0, m.index - 160), m.index + 200).replace(/\s+/g, ' ')}…`); }
        }
    }
    desc.push(`Scripts lidos: ${feitos.size}`, '', 'Endereços e arquivos citados:', '```', ...[...achados].slice(0, 200), '```', '', 'Trechos:', '```', ...trechos.slice(0, 80), '```', '');
    // tenta nomes prováveis
    const bases = [FILMES_BASE, ...['series', 'animes', 'doramas', 'novelas', 'kids', 'conteudo', 'vod'].map(n => `https://${n}-saimo.pages.dev`)];
    const nomes = ['indice.txt', ...['series', 'animes', 'doramas', 'novelas', 'novelinhas', 'kids', 'desenhos', 'infantil'].flatMap(n => [`${n}-A.txt`, `${n}.txt`, `${n}.json`]), 'series/indice.txt', 'series/A.txt'];
    const ok = [];
    for (const b of bases) for (const n of nomes) { if (b === FILMES_BASE && n === 'indice.txt') continue; const t = await baixar(b + '/' + n); if (t && !/^\s*<!doctype html/i.test(t)) ok.push(`${b}/${n} → ${t.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ⏎ ').slice(0, 300)}`); }
    desc.push('Nomes testados que abriram:', '```', ...(ok.length ? ok : ['(nenhum)']), '```', '');
}

async function main() {
    const inicio = Date.now();
    const desc = ['# 🔥 CZ Fire — descoberta', '', `Gerado em ${new Date().toISOString()}`, ''];
    const porCat = {};
    const vistos = new Set();
    const add = (cat, lista) => { const a = porCat[cat] = porCat[cat] || []; for (const it of lista) { const k = cat + '|' + it.name + '|' + it.url; if (!vistos.has(k)) { vistos.add(k); a.push(it); } } };

    for (const [rotulo, base, padrao] of [['Filmes', FILMES_BASE, 'filmes'], ['Canais', CANAIS_BASE, 'canais']]) {
        const indTxt = await baixar(`${base}/indice.txt`);
        const ind = lerIndice(indTxt);
        desc.push(`## ${rotulo} — ${base}`, '', indTxt == null ? '⚠️ indice.txt não abriu' : `Servidores (base:): ${Object.keys(ind.bases).length} · arquivos citados: ${ind.arquivos.length}`, '');
        if (ind.outras.length) desc.push('Outras linhas do índice:', '```', ...ind.outras.slice(0, 40), '```', '');
        let fila = ind.arquivos.slice();
        if (padrao === 'filmes') fila = fila.concat(LETRAS.map(l => `filmes-${l === '#' ? '%23' : l}.txt`));
        else fila = fila.concat(['canais.txt', 'canais.m3u', 'canais.json', 'lista.m3u']);
        fila = [...new Set(fila)];
        for (const arq of fila) {
            const url = /^https?:/i.test(arq) ? arq : `${base}/${arq}`;
            const txt = await baixar(url);
            if (txt == null) { if (ind.arquivos.includes(arq)) desc.push(`- ❌ ${arq} não abriu`); continue; }
            const cat = categoriaDe(arq, padrao);
            const itens = lerArquivo(arq, txt, cat, ind.bases);
            add(cat, itens);
            desc.push(`### ${arq} → ${cat} (${itens.length} itens)`, '```', ...txt.split(/\r?\n/).filter(Boolean).slice(0, 5).map(l => l.slice(0, 300)), '```', '');
            console.log(`📄 ${arq} → ${cat}: ${itens.length}`);
        }
    }

    if (process.argv.includes('--explorar') || process.env.FIRE_EXPLORAR) await explorar(desc);
    if (!SIMULAR) fs.mkdirSync(SAIDA, { recursive: true });
    const gravados = new Set(['resumo.json', 'descoberta.md']);
    const resumo = { geradoEm: new Date().toISOString(), categorias: {} };
    for (const [cat, itens] of Object.entries(porCat)) {
        if (!itens.length) continue;
        itens.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
        const partes = gravarCategoria(cat, itens, gravados);
        resumo.categorias[cat] = { itens: itens.length, partes };
    }
    const total = Object.values(resumo.categorias).reduce((s, c) => s + c.itens, 0);
    if (!total) { console.error('🛑 Nada veio das fontes — as listas antigas ficam como estão.'); process.exit(1); }
    if (!SIMULAR) {
        for (const f of fs.readdirSync(SAIDA)) if (!gravados.has(f) && /\.json$/.test(f)) fs.rmSync(path.join(SAIDA, f));   // parte que sobrou de uma rodada maior
        fs.writeFileSync(path.join(SAIDA, 'resumo.json'), JSON.stringify(resumo, null, 1) + '\n');
        fs.writeFileSync(path.join(SAIDA, 'descoberta.md'), desc.join('\n') + '\n');
    }
    console.log(`🔥 CZ Fire: ${total} itens · ${Object.entries(resumo.categorias).map(([c, v]) => `${c} ${v.itens}`).join(' · ')} · ${Math.round((Date.now() - inicio) / 1000)}s${SIMULAR ? ' (simulação)' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
