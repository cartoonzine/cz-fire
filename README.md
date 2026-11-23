# 🔥 CZ Fire

Ponte que baixa os dados emprestados do Saimo (filmes-saimo / canais-saimo) e publica **listas prontas por categoria** no formato do Cartoonzine, para usar nos envios do Sidechain.

- Robô: `.github/workflows/fire.yml` (a cada 6 h ou em **Actions → 🔥 CZ Fire → Run workflow**).
- Saída em `listas/`: `filmes.json`, `series.json`, `animes.json`, `doramas.json`, `novelas.json`, `novelinhas.json`, `kids.json`, `canais.json` (só as que existirem; listas grandes saem em partes `x-2.json`…).
- `listas/resumo.json`: quantos itens cada categoria tem. `listas/descoberta.md`: o que o índice do Saimo tem + amostras (para ajustar o leitor).
- Link para o Sidechain: `https://raw.githubusercontent.com/cartoonzine/cz-fire/main/listas/<categoria>.json`

Se uma rodada não trouxer nada, as listas antigas ficam como estão.
