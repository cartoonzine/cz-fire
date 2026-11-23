# 🔥 CZ Fire

Ponte sm (filmes-sm / canais-sm) e publica **listas prontas por categoria** no formato do CZ, para usar nos envios do Sidechain.

- Robô: `.github/workflows/fire.yml` (a cada 6 h ou em **Actions → 🔥 CZ Fire → Run workflow**).
- Lê o acervo como o app do Saimo: `indice.txt`, `filmes-X.txt`, `series-X.txt` + `series-X-N.txt` (episódios), `redeflix/links-animes.txt`, `redeflix/links-doramas.txt`, `novelinhas.txt` e `catalogo.txt` (canais). A categoria de cada título vem do `categorias.txt` deles (anime, dorama, novela, kids); capa, gênero, nota e classificação vêm de `fichas.txt` / `detalhes.txt`. O id do TMDB vem junto.
- Saída em `listas/`: `filmes.json`, `series.json`, `animes.json`, `doramas.json`, `novelas.json`, `novelinhas.json`, `kids.json`, `canais.json` (só as que existirem; listas grandes saem em partes `x-2.json`…).
- `listas/resumo.json`: quantos itens cada categoria tem. `listas/descoberta.md`: o que o índice do Saimo tem + amostras (para ajustar o leitor).
- Link para o Sidechain: `https://raw.githubusercontent.com/cartoonzine/cz-fire/main/listas/<categoria>.json`

Se uma rodada não trouxer nada, as listas antigas ficam como estão.
