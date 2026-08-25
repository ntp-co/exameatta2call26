'use strict';
/**
 * ATTA · Plataforma do Exame de Admissão
 * ---------------------------------------------------------------------
 * Aplicação de página única (SPA), escrita em JavaScript puro (sem
 * frameworks), organizada em módulos claros dentro de uma única IIFE
 * para não poluir o espaço global do browser.
 *
 * Índice deste ficheiro:
 *   1. CONFIGURAÇÃO           — constantes ajustáveis num único local
 *   2. DADOS                  — secções, banco de questões, categorias
 *   3. UTILITÁRIOS            — funções puras, sem efeitos secundários
 *   4. CAMADA DE PERSISTÊNCIA — abstrai o armazenamento (Claude / backend externo)
 *   5. LÓGICA DE NEGÓCIO      — correcção do exame e classificação
 *   6. ESTADO DA APLICAÇÃO    — estado único, imutável por fora
 *   7. COMPONENTES DE UI      — pequenas peças de interface reutilizáveis
 *   8. VISTAS                 — uma função por ecrã (state.view)
 *   9. CONTROLADOR            — render() e o ciclo de vida do temporizador
 *  10. AÇÕES                  — funções que mudam o estado e re-renderizam
 *  11. INICIALIZAÇÃO
 *
 * Princípios seguidos nesta reescrita:
 *   - Nunca usar innerHTML com texto proveniente de dados do utilizador
 *     (evita XSS); o único uso de innerHTML é para os ícones SVG fixos,
 *     definidos internamente nesta função, nunca com dados externos.
 *   - Todas as constantes de negócio (limiares de aprovação, duração do
 *     exame, etc.) vivem num único objecto CONFIG — nunca "números
 *     mágicos" espalhados pelo código.
 *   - O estado da aplicação é um único objecto, criado sempre pela
 *     mesma função (createInitialState), para eliminar o risco de
 *     esquecer de repor algum campo ao voltar ao início.
 *   - A geração aleatória usa um gerador pseudo-aleatório de melhor
 *     qualidade (mulberry32) em vez de um LCG fraco, garantindo uma
 *     distribuição mais equilibrada na ordem das perguntas/opções.
 *   - Cada função tem um único objectivo (separação de UI, estado,
 *     rede e regras de negócio), o que facilita testar e corrigir.
 */
(function () {

  /* =====================================================================
   * 1. CONFIGURAÇÃO
   * Todas as constantes ajustáveis da plataforma, num único local.
   * ===================================================================== */
  const CONFIG = Object.freeze({
    /** Tempo concedido para cada questão individual, em segundos.
     *  Ao esgotar-se, a questão fica automaticamente por responder
     *  (contada como errada) e avança-se para a seguinte. */
    QUESTION_DURATION_SECONDS: 45,

    /** A partir de quantos segundos restantes o cronómetro da questão fica "em alerta". */
    TIMER_WARNING_SECONDS: 10,

    /** Código de acesso à Área da Comissão Técnica.
     *  IMPORTANTE: isto é apenas uma barreira simples do lado do
     *  cliente — qualquer pessoa que veja o código-fonte da página
     *  consegue ler este valor. Não usar para dados verdadeiramente
     *  sensíveis; trocar antes de qualquer uso público. */
    ADMIN_ACCESS_CODE: "EXADMATTA26",

    /**
     * URL do backend externo (Google Apps Script), opcional.
     * Vazio ("") = usa o armazenamento interno do Claude, que só
     * funciona quando esta página é aberta através do Claude.
     * Preenchido = a plataforma grava/lê num Google Sheets próprio,
     * funcionando também fora do Claude (link público, site da ATTA).
     * Ver Code.gs para as instruções de publicação.
     */
    BACKEND_URL: "https://script.google.com/macros/s/AKfycbySKqDBMrXIqZUo8X7x8PbbclHvcoiCOOqozil0TztC0iMk6Libfg9pjDI2oLWb9_Ai/exec",

    /** Nota mínima geral (ponderada pelas 5 secções) para aprovação. */
    APPROVAL_MIN_OVERALL_PERCENT: 70,

    /** Nota mínima exigida em CADA secção, mesmo com a média geral ok. */
    APPROVAL_MIN_SECTION_PERCENT: 50,

    /** Número de mudanças de aba/janela a partir do qual a linha fica
     *  realçada no painel da Comissão como possível indício de consulta
     *  externa (uso apenas informativo, abaixo do limite de desclassificação). */
    TAB_SWITCH_ALERT_THRESHOLD: 2,

    /** Número de mudanças de aba/janela que, ao ser ULTRAPASSADO
     *  (ou seja, a partir da 4ª ocorrência), desclassifica automaticamente
     *  o candidato e termina o exame de imediato. */
    TAB_SWITCH_DISQUALIFY_THRESHOLD: 3,
  });

  /* =====================================================================
   * 2. DADOS
   * Conteúdo do exame: secções e pesos, banco de 20 questões técnicas,
   * categorias profissionais dos candidatos e sugestões de leitura.
   * ===================================================================== */

  /** As 5 secções do exame, com o respectivo peso (%) na nota final. */
  const SECTIONS = [
  {
    "id": 1,
    "name": "Fundamentos de Topografia",
    "weight": 25
  },
  {
    "id": 2,
    "name": "Instrumentação",
    "weight": 25
  },
  {
    "id": 3,
    "name": "Cálculo e Ajustamento de Dados",
    "weight": 20
  },
  {
    "id": 4,
    "name": "Cartografia e Sistemas de Coordenadas",
    "weight": 15
  },
  {
    "id": 5,
    "name": "Legislação, Ética e Deontologia",
    "weight": 15
  }
];

  /** Banco de questões técnicas (escolha múltipla, 4 opções cada). */
  const QUESTIONS = [
  {
    "id": 1,
    "section": 1,
    "text": "Qual a principal diferença entre o nivelamento geométrico e o nivelamento trigonométrico?",
    "options": [
      "O geométrico usa apenas GPS e o trigonométrico usa apenas estação total.",
      "O geométrico determina desníveis por visadas horizontais com nível e mira; o trigonométrico calcula o desnível a partir de distâncias e ângulos verticais.",
      "Não existe diferença prática entre os dois métodos.",
      "O trigonométrico só pode ser usado em terrenos planos."
    ],
    "answer": 1
  },
  {
    "id": 2,
    "section": 1,
    "text": "O erro de esfericidade e refracção atmosférica torna-se significativo em que situação?",
    "options": [
      "Apenas em levantamentos de pequena distância (< 50 m).",
      "Apenas quando se usa nível digital.",
      "Em visadas de longa distância, sendo corrigido através de fórmulas de correcção combinada ou pela leitura de meio-de-mira.",
      "Nunca é relevante em topografia."
    ],
    "answer": 2
  },
  {
    "id": 3,
    "section": 1,
    "text": "Azimute é definido como:",
    "options": [
      "O ângulo horizontal medido a partir do Norte, no sentido horário, até à direcção pretendida.",
      "A distância inclinada entre dois pontos.",
      "O ângulo vertical entre o horizonte e um ponto observado.",
      "A diferença de cota entre dois pontos."
    ],
    "answer": 0
  },
  {
    "id": 4,
    "section": 1,
    "text": "Uma poligonal fechada caracteriza-se por:",
    "options": [
      "Iniciar e terminar em pontos distintos, sem controlo de erro.",
      "Iniciar e terminar no mesmo ponto (ou em pontos de coordenadas conhecidas), permitindo o cálculo e distribuição do erro de fecho.",
      "Ser aplicável apenas em levantamentos batimétricos.",
      "Não necessitar de ajustamento angular."
    ],
    "answer": 1
  },
  {
    "id": 5,
    "section": 1,
    "text": "A diferença entre precisão e exactidão em topografia é:",
    "options": [
      "São sinónimos e não há diferença.",
      "Precisão refere-se à dispersão das medições entre si; exactidão refere-se à proximidade da medição em relação ao valor real.",
      "Exactidão refere-se apenas ao instrumento utilizado.",
      "Precisão só se aplica a levantamentos com GPS."
    ],
    "answer": 1
  },
  {
    "id": 6,
    "section": 2,
    "text": "A observação em dupla posição (face directa e face inversa) numa Estação Total tem como objectivo principal:",
    "options": [
      "Reduzir o tempo de trabalho de campo.",
      "Eliminar ou minimizar erros instrumentais sistemáticos, como o erro de colimação e de índice vertical.",
      "Aumentar o alcance do distanciómetro.",
      "Substituir a necessidade de calibração periódica do equipamento."
    ],
    "answer": 1
  },
  {
    "id": 7,
    "section": 2,
    "text": "Qual a principal diferença entre GPS RTK e GPS estático (pós-processado)?",
    "options": [
      "O RTK fornece correcção e posicionamento em tempo real, com precisão centimétrica imediata; o estático requer pós-processamento dos dados recolhidos durante um período mais longo.",
      "O GPS estático é sempre mais rápido do que o RTK.",
      "Não existe diferença de precisão entre os dois métodos.",
      "O RTK não necessita de estação base ou de correção via rede."
    ],
    "answer": 0
  },
  {
    "id": 8,
    "section": 2,
    "text": "A verificação e calibração de um nível óptico antes do trabalho de campo serve principalmente para:",
    "options": [
      "Aumentar a distância máxima de visada.",
      "Substituir o uso da mira.",
      "Garantir que o eixo de colimação está paralelo ao eixo da bolha (nível), reduzindo o erro sistemático de horizontalidade da linha de visada.",
      "Verificar apenas a bateria do equipamento."
    ],
    "answer": 2
  },
  {
    "id": 9,
    "section": 2,
    "text": "Na leitura de uma mira, os fios estadimétricos (superior, médio e inferior) permitem, entre outros usos:",
    "options": [
      "Determinar a distância taqueométrica e verificar a leitura através da relação: fio médio ≈ (fio superior + fio inferior) / 2.",
      "Calcular directamente as coordenadas UTM sem cálculos adicionais.",
      "Substituir a necessidade de nivelamento.",
      "Medir apenas ângulos horizontais."
    ],
    "answer": 0
  },
  {
    "id": 10,
    "section": 2,
    "text": "O prisma reflector utilizado com a Estação Total tem como função:",
    "options": [
      "Reflectir o sinal do distanciómetro electrónico (EDM) para permitir a medição da distância entre o instrumento e o ponto observado.",
      "Amplificar o sinal de GPS.",
      "Substituir a mira em nivelamento geométrico.",
      "Corrigir automaticamente o erro de refracção atmosférica."
    ],
    "answer": 0
  },
  {
    "id": 11,
    "section": 3,
    "text": "Numa poligonal fechada com n vértices, a soma teórica dos ângulos internos deve ser (n-2)×180°. Se a soma medida for superior, o erro de fecho angular é:",
    "options": [
      "Sempre igual a zero.",
      "A diferença entre a soma medida e a soma teórica, a qual deve ser distribuída (compensada) pelos vértices da poligonal.",
      "Irrelevante para o cálculo das coordenadas.",
      "Corrigido apenas alterando as distâncias medidas."
    ],
    "answer": 1
  },
  {
    "id": 12,
    "section": 3,
    "text": "O método de cálculo de área de um polígono a partir das coordenadas dos vértices (Gauss/Shoelace) baseia-se em:",
    "options": [
      "Multiplicar directamente o perímetro pela altura média.",
      "Uma estimativa visual sobre a planta.",
      "Uma soma algébrica dos produtos cruzados das coordenadas (X,Y) sucessivas dos vértices, dividida por dois.",
      "Não é aplicável a polígonos irregulares."
    ],
    "answer": 2
  },
  {
    "id": 13,
    "section": 3,
    "text": "No nivelamento trigonométrico, o desnível (ΔH) entre dois pontos é calculado, de forma simplificada, a partir de:",
    "options": [
      "Da distância horizontal e do ângulo vertical observado, através de ΔH = D × tan(ângulo vertical), com ajuste das alturas de instrumento e prisma/mira.",
      "Apenas da distância inclinada, sem necessidade do ângulo vertical.",
      "Da leitura directa do fio médio, sem cálculo trigonométrico.",
      "Da diferença entre coordenadas X de dois pontos."
    ],
    "answer": 0
  },
  {
    "id": 14,
    "section": 3,
    "text": "O método de Bowditch (ou da bússola), usado na compensação de poligonais, distribui o erro de fecho linear:",
    "options": [
      "Igualmente por todos os vértices, independentemente do comprimento dos lados.",
      "Proporcionalmente ao comprimento de cada lado da poligonal em relação ao perímetro total.",
      "Apenas no último lado da poligonal.",
      "Não é utilizado em ajustamento de poligonais."
    ],
    "answer": 1
  },
  {
    "id": 15,
    "section": 4,
    "text": "O Datum geodésico utilizado num levantamento é importante porque:",
    "options": [
      "É apenas uma formalidade administrativa sem impacto técnico.",
      "Define a superfície de referência (elipsóide) e o sistema de coordenadas associado; a escolha incorrecta pode gerar discrepâncias significativas de posição.",
      "Serve apenas para trabalhos batimétricos.",
      "Não afecta a compatibilidade entre diferentes levantamentos."
    ],
    "answer": 1
  },
  {
    "id": 16,
    "section": 4,
    "text": "A escala numérica de uma carta topográfica (ex.: 1:10.000) indica que:",
    "options": [
      "Uma unidade de medida no mapa corresponde a 10.000 unidades da mesma medida no terreno.",
      "O mapa cobre uma área de 10.000 metros quadrados.",
      "Existem 10.000 curvas de nível na carta.",
      "É equivalente a uma escala gráfica de 1 cm = 1 km em qualquer situação."
    ],
    "answer": 0
  },
  {
    "id": 17,
    "section": 4,
    "text": "O sistema de projecção cartográfica UTM (Universal Transversa de Mercator) divide o globo em:",
    "options": [
      "Fusos de 6° de longitude, cada um com o seu meridiano central.",
      "Apenas dois hemisférios, sem subdivisão adicional.",
      "Círculos concêntricos a partir do Equador.",
      "Não é aplicável ao território angolano."
    ],
    "answer": 0
  },
  {
    "id": 18,
    "section": 5,
    "text": "Perante um levantamento cujos resultados possam ser usados para fins de litígio de propriedade, o topógrafo deve:",
    "options": [
      "Alterar os dados conforme a conveniência do cliente que contratou o serviço.",
      "Garantir rigor técnico, imparcialidade e reportar fielmente os resultados obtidos, independentemente de quem contratou o serviço.",
      "Recusar-se sempre a realizar o levantamento.",
      "Delegar toda a responsabilidade ao cliente."
    ],
    "answer": 1
  },
  {
    "id": 19,
    "section": 5,
    "text": "De acordo com o Estatuto da ATTA, compete à Associação, entre outras funções:",
    "options": [
      "Fiscalizar e promover a excelência e a ética no exercício da profissão de topógrafo em Angola.",
      "Substituir o papel dos tribunais em litígios de propriedade.",
      "Definir directamente os preços de mercado dos serviços de topografia.",
      "Não tem qualquer papel na admissão de novos associados."
    ],
    "answer": 0
  },
  {
    "id": 20,
    "section": 5,
    "text": "O sigilo profissional em topografia implica que o técnico:",
    "options": [
      "Pode partilhar livremente dados de clientes com terceiros sem autorização.",
      "Deve evitar conflitos de interesse e não divulgar informações confidenciais obtidas no exercício da profissão sem autorização do cliente, salvo obrigação legal.",
      "Só se aplica a levantamentos governamentais.",
      "Não é uma responsabilidade deontológica do topógrafo."
    ],
    "answer": 1
  }
];

  /** Categorias profissionais apresentadas no formulário de inscrição. */
  const CATEGORIES = [
  {
    "id": "ipcg",
    "label": "Formado pela Escola de Topografia (IPCG / ex-IGCA)",
    "hint": "Indique o ano de conclusão e, se tiver, o nº de aluno/matrícula no IPCG (ex-IGCA)"
  },
  {
    "id": "empresa",
    "label": "Formado em contexto empresarial (obra / empresa de construção civil ou levantamento)",
    "hint": "Indique a(s) empresa(s) onde adquiriu a formação prática e por quantos anos"
  },
  {
    "id": "estudante",
    "label": "Candidato / estudante — ainda em formação académica",
    "hint": "Indique a instituição que frequenta e o ano curricular actual"
  },
  {
    "id": "curso_curto",
    "label": "Curso de formação técnica de curta duração (poucos meses)",
    "hint": "Indique o nome do curso, a instituição formadora e a duração"
  },
  {
    "id": "senior",
    "label": "Técnico sénior / percursor da topografia em Angola (longa experiência)",
    "hint": "Indique, de forma resumida, o percurso profissional e as principais empresas/projectos"
  }
];

  /** Sugestões de leitura por secção, mostradas quando o desempenho
   *  nessa secção fica abaixo do nível "domínio consolidado". */
  const STUDY_REFERENCES = {
  "1": [
    "\"Topografia\" — L. Espartel",
    "\"Fundamentals of Surveying\" — Schmidt & Rayner"
  ],
  "2": [
    "Manuais do fabricante da Estação Total / GPS RTK utilizados em campo",
    "\"Surveying: Principles and Applications\" — Kavanagh"
  ],
  "3": [
    "\"Adjustment Computations: Spatial Data Analysis\" — Ghilani",
    "\"Topografia Aplicada\" — Casaca, Matos & Baio"
  ],
  "4": [
    "\"Cartografia Básica\" — F. Joly",
    "\"Elements of Cartography\" — Robinson et al."
  ],
  "5": [
    "Estatuto da ATTA",
    "Código Deontológico do Topógrafo (documento interno da ATTA)"
  ]
};

  /** Logótipo da ATTA, embutido como PNG em base64 (evita pedir um
   *  ficheiro externo, o que falharia em contextos offline/sandbox). */
  const LOGO_DATA_URI = "data:image/png;base64,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";

  /* =====================================================================
   * 3. UTILITÁRIOS
   * Funções puras (sem efeitos secundários), reutilizadas em várias
   * partes da aplicação.
   * ===================================================================== */

  /**
   * Gerador de números pseudo-aleatórios determinístico (mulberry32).
   * Dado o mesmo "seed", produz sempre a mesma sequência — usado para
   * embaralhar perguntas/opções de forma reproduzível por candidato
   * (o mesmo candidato, se recarregar a página a meio, veria a mesma
   * ordem). É preferível a um LCG simples por ter uma distribuição
   * estatística mais equilibrada.
   * @param {number} seed - semente inicial (inteiro).
   * @returns {() => number} função que devolve um float em [0, 1) a cada chamada.
   */
  function createSeededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Deriva uma semente numérica estável a partir de um texto (por
   * exemplo, nome + email do candidato), para que a mesma pessoa
   * obtenha sempre a mesma ordem de perguntas/opções.
   * @param {string} text
   * @returns {number}
   */
  function seedFromText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  /**
   * Devolve uma cópia embaralhada do array, usando Fisher-Yates com
   * um gerador determinístico. Nunca modifica o array original.
   * @template T
   * @param {T[]} array
   * @param {number} seed
   * @returns {T[]}
   */
  function shuffleDeterministic(array, seed) {
    const result = array.slice();
    const random = createSeededRandom(seed);
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * Formata um número de segundos como "MM:SS" ou "H:MM:SS" quando
   * ultrapassa uma hora.
   * @param {number} totalSeconds
   * @returns {string}
   */
  function formatDuration(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  /**
   * Validação simples (não exaustiva) de formato de email — suficiente
   * para apanhar erros de digitação óbvios sem bloquear endereços
   * válidos menos comuns.
   * @param {string} value
   * @returns {boolean}
   */
  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());
  }

  /**
   * Normaliza texto para comparação (usado na verificação de nome/email
   * duplicados): remove espaços nas pontas e ignora maiúsculas/minúsculas.
   * @param {string} value
   * @returns {string}
   */
  function normalizeForComparison(value) {
    return (value || '').trim().toLowerCase();
  }

  /**
   * Cria um elemento DOM de forma segura. NUNCA interpreta `children`
   * como HTML — cada item é ou um Node já criado, ou uma string que é
   * inserida como texto simples (nunca como marcação). Isto elimina
   * uma classe inteira de bugs de XSS que existiam na versão anterior,
   * onde um atributo `html` permitia injectar innerHTML livremente.
   *
   * @param {string} tag - nome da tag (ex: 'div', 'button').
   * @param {Object} [attrs] - atributos; chaves iniciadas por "on"
   *        (ex: onClick) são registadas como event listeners; "class"
   *        define a className; as restantes são setAttribute normais.
   * @param {(Node|string)[]} [children] - filhos a anexar.
   * @returns {HTMLElement}
   */
  function dom(tag, attrs, children) {
    const element = document.createElement(tag);
    if (attrs) {
      for (const key in attrs) {
        const value = attrs[key];
        if (value === undefined || value === null) continue;
        if (key === 'class') element.className = value;
        else if (key.startsWith('on') && typeof value === 'function') {
          element.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          element.setAttribute(key, value);
        }
      }
    }
    (children || []).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return element;
  }

  /**
   * Único ponto da aplicação onde se usa innerHTML — exclusivamente
   * para inserir marcação SVG gerada internamente (nunca a partir de
   * dados do utilizador). Mantido isolado e bem assinalado para que
   * qualquer revisão futura veja de imediato que é seguro.
   * @param {string} trustedSvgMarkup
   * @returns {HTMLElement}
   */
  function renderTrustedIcon(trustedSvgMarkup) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = trustedSvgMarkup; // marcação fixa, definida abaixo — nunca dados externos
    return wrapper.firstElementChild;
  }

  /**
   * Ícone em forma de "marco geodésico" (disco com triângulo e mira),
   * usado como assinatura visual da plataforma. `color` é sempre um
   * valor definido internamente (nunca vindo de input do utilizador).
   * @param {number} size - tamanho em pixels (largura = altura).
   * @param {string} color - cor CSS válida.
   * @returns {HTMLElement}
   */
  function benchmarkIcon(size, color) {
    const svg = `<svg viewBox="0 0 100 100" width="${size}" height="${size}">
      <circle cx="50" cy="50" r="47" fill="none" stroke="${color}" stroke-width="2.5"/>
      <circle cx="50" cy="50" r="38" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="2 3"/>
      <polygon points="50,20 76,64 24,64" fill="none" stroke="${color}" stroke-width="2.5"/>
      <circle cx="50" cy="50" r="3.4" fill="${color}"/>
      <line x1="50" y1="5" x2="50" y2="14" stroke="${color}" stroke-width="2"/>
      <line x1="50" y1="86" x2="50" y2="95" stroke="${color}" stroke-width="2"/>
      <line x1="5" y1="50" x2="14" y2="50" stroke="${color}" stroke-width="2"/>
      <line x1="86" y1="50" x2="95" y2="50" stroke="${color}" stroke-width="2"/>
    </svg>`;
    return renderTrustedIcon(svg);
  }


  /* =====================================================================
   * 4. CAMADA DE PERSISTÊNCIA
   * Isola todo o código de acesso a dados (armazenamento do Claude ou
   * backend externo) atrás de uma única interface — Storage.save(),
   * Storage.checkDuplicate() e Storage.listAll(). O resto da aplicação
   * não precisa de saber qual dos dois modos está activo.
   *
   * Antes, esta lógica estava duplicada e espalhada por várias funções
   * (checkAlreadyTaken, saveResult, loadResults, loadAdmin), tornando
   * fácil esquecer de actualizar um dos caminhos ao alterar campos —
   * foi exactamente essa duplicação que causou mais do que um bug
   * durante o desenvolvimento anterior desta plataforma.
   * ===================================================================== */
  const Storage = (function () {
    const hasClaudeStorage = (typeof window.storage !== 'undefined' && window.storage !== null);
    const hasExternalBackend = Boolean(CONFIG.BACKEND_URL);

    /** Indica se algum mecanismo de persistência está disponível. */
    function isAvailable() {
      return hasExternalBackend || hasClaudeStorage;
    }

    /**
     * Converte uma linha crua vinda do backend externo (Google Sheets,
     * onde tudo chega como texto/objecto simples) para o mesmo formato
     * usado internamente pela aplicação.
     * @param {Object} row
     * @returns {Object}
     */
    function normalizeExternalRow(row) {
      let sections = [];
      try {
        sections = typeof row['Detalhe JSON'] === 'string' ? JSON.parse(row['Detalhe JSON']) : [];
      } catch (err) {
        console.error('Não foi possível interpretar o detalhe por secção de uma submissão.', err);
      }
      return {
        name: row['Nome'] || '',
        email: row['Email'] || '',
        phone: row['Telefone'] || '',
        idNumber: row['Matrícula/ID'] || '',
        category: row['Categoria'] || '',
        categoryLabel: row['Categoria'] || '',
        trainingDetail: row['Detalhe da Formação'] || '',
        experience: row['Experiência'] || '',
        workplace: row['Instituição/Empresa'] || '',
        overall: Number(row['Nota Geral']) || 0,
        approved: row['Aprovado'] === 'Sim' || row['Aprovado'] === true,
        disqualified: row['Desclassificado'] === 'Sim' || row['Desclassificado'] === true,
        submittedAt: row['Timestamp'] || new Date().toISOString(),
        timeUsedSec: Number(row['Tempo Usado (s)']) || 0,
        tabSwitches: Number(row['Mudanças de Aba']) || 0,
        sections,
      };
    }

    /**
     * Grava o resultado de uma submissão.
     * @param {Object} result - objecto de resultado (ver scoreExam()).
     * @returns {Promise<'ok'|'duplicate'|'failed'|'unavailable'>}
     */
    async function save(result) {
      if (hasExternalBackend) {
        try {
          const response = await fetch(CONFIG.BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita pre-flight CORS no Apps Script
            body: JSON.stringify(result),
          });
          const data = await response.json().catch(() => null);
          if (data && data.status === 'ok') return 'ok';
          if (data && data.status === 'duplicate') return 'duplicate';
          return 'failed';
        } catch (err) {
          console.error('Falha ao gravar no backend externo.', err);
          return 'failed';
        }
      }
      if (!hasClaudeStorage) return 'unavailable';
      try {
        const key = `submission:${Date.now()}_${result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        await window.storage.set(key, JSON.stringify(result), true);
        return 'ok';
      } catch (err) {
        console.error('Falha ao guardar submissão no armazenamento do Claude.', err);
        return 'failed';
      }
    }

    /**
     * Verifica se já existe uma submissão anterior com o mesmo nome
     * OU o mesmo email (qualquer um dos dois basta para bloquear).
     * @param {string} name
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    async function checkDuplicate(name, email) {
      const targetName = normalizeForComparison(name);
      const targetEmail = normalizeForComparison(email);
      if (!targetName && !targetEmail) return false;

      if (hasExternalBackend) {
        try {
          const url = `${CONFIG.BACKEND_URL}?checkEmail=${encodeURIComponent(targetEmail)}&checkName=${encodeURIComponent(targetName)}`;
          const response = await fetch(url);
          const data = await response.json();
          return Boolean(data && data.exists);
        } catch (err) {
          console.error('Falha ao verificar duplicado no backend externo.', err);
          return false; // nunca bloquear o candidato por uma falha de rede
        }
      }
      if (!hasClaudeStorage) return false;
      try {
        const listing = await window.storage.list('submission:', true);
        const keys = (listing && listing.keys) || [];
        for (const key of keys) {
          try {
            const record = await window.storage.get(key, true);
            if (!record || !record.value) continue;
            const parsed = JSON.parse(record.value);
            const parsedName = normalizeForComparison(parsed.name);
            const parsedEmail = normalizeForComparison(parsed.email);
            if ((targetEmail && parsedEmail === targetEmail) || (targetName && parsedName === targetName)) {
              return true;
            }
          } catch (err) {
            // um registo isolado corrompido não deve impedir a verificação dos restantes
            console.error('Registo de submissão ilegível, a ignorar.', err);
          }
        }
        return false;
      } catch (err) {
        console.error('Falha ao consultar armazenamento do Claude.', err);
        return false;
      }
    }

    /**
     * Lista todas as submissões (uso exclusivo do painel da Comissão).
     * @returns {Promise<{items: Object[], unavailable: boolean}>}
     */
    async function listAll() {
      if (hasExternalBackend) {
        try {
          const url = `${CONFIG.BACKEND_URL}?code=${encodeURIComponent(CONFIG.ADMIN_ACCESS_CODE)}`;
          const response = await fetch(url);
          const data = await response.json();
          if (!data || data.error) return { items: [], unavailable: false };
          return { items: data.map(normalizeExternalRow), unavailable: false };
        } catch (err) {
          console.error('Falha ao carregar submissões do backend externo.', err);
          return { items: [], unavailable: false };
        }
      }
      if (!hasClaudeStorage) return { items: [], unavailable: true };
      try {
        const listing = await window.storage.list('submission:', true);
        const keys = (listing && listing.keys) || [];
        const items = [];
        for (const key of keys) {
          try {
            const record = await window.storage.get(key, true);
            if (record && record.value) items.push(JSON.parse(record.value));
          } catch (err) {
            console.error('Registo de submissão ilegível, a ignorar.', err);
          }
        }
        return { items, unavailable: false };
      } catch (err) {
        console.error('Falha ao listar submissões no armazenamento do Claude.', err);
        return { items: [], unavailable: false };
      }
    }

    return { isAvailable, save, checkDuplicate, listAll };
  })();


  /* =====================================================================
   * 5. LÓGICA DE NEGÓCIO
   * Regras de correcção e classificação do exame — isoladas da UI para
   * poderem ser testadas e alteradas sem mexer em código de interface.
   * ===================================================================== */

  /**
   * Corrige o exame e calcula o resultado completo.
   * @param {Object} candidateAnswers - mapa { [questionId]: opçãoEscolhidaOriginalIndex }
   * @param {Object[]} orderedQuestions - lista de questões na ordem apresentada ao candidato
   * @param {number} tabSwitches - nº de vezes que a aba perdeu o foco durante a prova
   * @param {number} timeUsedSec - tempo efectivamente usado, em segundos
   * @returns {Object} resultado completo (usado tanto para gravação como para o ecrã de feedback)
   */
  function scoreExam(candidateAnswers, orderedQuestions, tabSwitches, timeUsedSec) {
    const bySection = new Map();
    SECTIONS.forEach((section) => bySection.set(section.id, { correct: 0, total: 0 }));

    orderedQuestions.forEach((question) => {
      const bucket = bySection.get(question.section);
      bucket.total += 1;
      if (candidateAnswers[question.id] === question.answer) bucket.correct += 1;
    });

    let weightedOverall = 0;
    const sectionResults = SECTIONS.map((section) => {
      const bucket = bySection.get(section.id);
      const percent = bucket.total ? (bucket.correct / bucket.total) * 100 : 0;
      weightedOverall += percent * (section.weight / 100);
      return {
        id: section.id,
        name: section.name,
        weight: section.weight,
        correct: bucket.correct,
        total: bucket.total,
        pct: percent,
      };
    });

    const allSectionsAboveMinimum = sectionResults.every(
      (section) => section.pct >= CONFIG.APPROVAL_MIN_SECTION_PERCENT
    );
    const approved = weightedOverall >= CONFIG.APPROVAL_MIN_OVERALL_PERCENT && allSectionsAboveMinimum;
    const totalCorrect = sectionResults.reduce((sum, section) => sum + section.correct, 0);

    return {
      overall: Math.round(weightedOverall * 10) / 10,
      totalCorrect,
      totalQuestions: orderedQuestions.length,
      approved,
      sections: sectionResults,
      timeUsedSec,
      tabSwitches,
    };
  }

  /**
   * Traduz uma percentagem de acerto numa secção para um nível
   * qualitativo (o candidato nunca vê a percentagem exacta — apenas
   * esta classificação e, se aplicável, sugestões de leitura).
   * @param {number} percent
   * @returns {{key: string, label: string, color: string}}
   */
  function qualitativeLevel(percent) {
    if (percent >= 80) return { key: 'green', label: 'Domínio consolidado', color: 'var(--good)' };
    if (percent >= 50) return { key: 'amber', label: 'Base presente — recomenda-se aprofundar', color: '#B8862E' };
    return { key: 'red', label: 'Área a reforçar', color: 'var(--bad)' };
  }

  /* =====================================================================
   * 6. ESTADO DA APLICAÇÃO
   * Estado único e centralizado. createInitialState() é o ÚNICO local
   * que define a "forma" do estado — tanto o arranque da aplicação como
   * o botão "Sair" usam esta mesma função, eliminando o risco (que
   * existiu na versão anterior) de um reset esquecer de repor algum
   * campo novo adicionado mais tarde.
   * ===================================================================== */

  /** @returns {Object} um novo estado inicial, independente de qualquer estado anterior. */
  function createInitialState() {
    return {
      /** Vista actual: landing | consent | checking | blocked | exam | result | disqualified | admin-gate | admin */
      view: 'landing',
      candidate: { name: '', email: '', phone: '', idNumber: '', category: '', trainingDetail: '', experience: '', workplace: '' },
      agreedToTerms: false,
      orderedQuestions: [],      // questões já embaralhadas para este candidato
      optionOrderByQuestion: {}, // { [questionId]: [índiceOriginal, ...] } — ordem das opções apresentadas
      answers: {},               // { [questionId]: índiceOriginalEscolhido }
      currentQuestionIndex: 0,
      questionTimeLeftSeconds: CONFIG.QUESTION_DURATION_SECONDS, // cronómetro da questão actual (45s)
      questionTimerIntervalId: null,
      examStartedAt: null,       // timestamp (ms) do início do exame — usado para calcular o tempo total usado
      tabSwitches: 0,
      disqualified: false,       // true quando ultrapassa o limite de mudanças de aba
      result: null,
      saveStatus: null,          // 'ok' | 'duplicate' | 'failed' | 'unavailable'
      adminSubmissions: null,    // null = ainda não carregado
      adminStorageUnavailable: false,
      adminAccessError: '',
    };
  }

  /** Estado único da aplicação (mutável internamente; nunca acedido de fora da IIFE). */
  let state = createInitialState();


  /* =====================================================================
   * 7. COMPONENTES DE UI
   * Peças pequenas e reutilizáveis, usadas por várias vistas.
   * ===================================================================== */

  /** Cabeçalho fixo, mostrado em todas as vistas. */
  function Topbar() {
    return dom('div', { class: 'topbar' }, [
      dom('img', { src: LOGO_DATA_URI, alt: 'Logótipo ATTA', class: 'disc', style: 'object-fit:contain;' }),
      dom('div', { class: 'brand-text' }, [
        dom('b', {}, ['ATTA · EXAME DE ADMISSÃO']),
        'Comissão Técnica de Trabalho — Processo de Exame de Admissão',
      ]),
    ]);
  }

  /**
   * Faixa colorida de aviso/confirmação (usada nos ecrãs de resultado
   * e do painel da Comissão). Substitui vários blocos de estilo inline
   * repetidos na versão anterior.
   * @param {'success'|'error'} kind
   * @param {string} message
   */
  function Banner(kind, message) {
    const palette = kind === 'success'
      ? { bg: 'var(--good-soft)', border: 'var(--good)', color: 'var(--good)' }
      : { bg: 'var(--bad-soft)', border: 'var(--bad)', color: 'var(--bad)' };
    return dom('div', {
      style: `background:${palette.bg};border:1px solid ${palette.border};color:${palette.color};` +
        'padding:11px 14px;border-radius:var(--radius);font-size:13px;margin-bottom:14px;',
    }, [message]);
  }

  /** Botão principal (acção primária). */
  function PrimaryButton(label, onClick, extraAttrs) {
    return dom('button', Object.assign({ class: 'btn', onclick: onClick }, extraAttrs || {}), [label]);
  }

  /** Botão secundário (acção de apoio, ex: "Voltar", "Sair"). */
  function SecondaryButton(label, onClick, extraAttrs) {
    return dom('button', Object.assign({ class: 'btn secondary', onclick: onClick }, extraAttrs || {}), [label]);
  }

  /** Campo de formulário com rótulo, devolve {wrapper, input}. */
  function FormField({ id, label, type = 'text', placeholder = '', value = '' }) {
    const input = dom('input', { type, id, placeholder });
    input.value = value;
    const wrapper = dom('div', {}, [dom('label', {}, [label]), input]);
    return { wrapper, input };
  }

  /**
   * Sobreposição de marca d'água, repetida por todo o ecrã do exame,
   * com o nome e o email do candidato. Não impede fisicamente uma
   * captura de ecrã (nenhuma página web consegue impedir isso — é uma
   * limitação do próprio sistema operativo, fora do alcance do
   * browser), mas torna qualquer captura ou partilha identificável,
   * o que na prática desencoraja fortemente essa partilha.
   * @param {string} name
   * @param {string} email
   * @returns {HTMLElement}
   */
  function SecurityWatermark(name, email) {
    const label = `${name} · ${email} · ${new Date().toLocaleString('pt-PT')}`;
    const overlay = dom('div', { class: 'watermark-overlay', 'aria-hidden': 'true' });
    for (let i = 0; i < 60; i++) {
      overlay.appendChild(dom('span', { class: 'watermark-item' }, [label]));
    }
    return overlay;
  }


  /* =====================================================================
   * 8. VISTAS
   * Uma função por ecrã. Cada vista é uma função pura em relação ao
   * `state` (lê o estado actual e devolve um elemento DOM); só as
   * AÇÕES (secção 10) alteram o estado.
   * ===================================================================== */
  const Views = {};

  Views.landing = function () {
    const card = dom('div', { class: 'card' });
    card.appendChild(dom('div', { class: 'landing-hero' }, [
      dom('div', { class: 'eyebrow' }, ['Despacho Nº 001/2026 · 02 de Agosto']),
      dom('h1', {}, ['Exame de Admissão de Novos Associados']),
      dom('p', {}, ['Avaliação técnica em modalidade online, elaborada pela Comissão Técnica de Trabalho da ATTA. Leia as instruções e preencha os seus dados para iniciar.']),
    ]));
    card.appendChild(dom('div', { class: 'meta-row' }, [
      dom('span', {}, [dom('b', {}, ['90 min']), ' duração']),
      dom('span', {}, [dom('b', {}, [String(QUESTIONS.length)]), ' questões']),
      dom('span', {}, [dom('b', {}, [`${CONFIG.APPROVAL_MIN_OVERALL_PERCENT}%`]), ' nota mínima']),
    ]));

    const nameField = FormField({ id: 'field-name', label: 'Nome completo', placeholder: 'Ex: Joaquim Lino', value: state.candidate.name });
    const emailField = FormField({ id: 'field-email', label: 'Email', type: 'email', placeholder: 'nome@exemplo.com', value: state.candidate.email });
    const phoneField = FormField({ id: 'field-phone', label: 'Nº de telefone', placeholder: 'Ex: 9XX XXX XXX', value: state.candidate.phone });
    const idField = FormField({ id: 'field-id', label: 'Nº de matrícula ou documento de identificação (BI, cédula ou nº de estudante)', placeholder: 'Ex: nº do BI, ou nº de matrícula IPCG', value: state.candidate.idNumber });

    const categoryLabel = dom('label', {}, ['Categoria profissional']);
    const categorySelect = dom('select', { id: 'field-category', class: 'select-input' });
    categorySelect.appendChild(dom('option', { value: '' }, ['Seleccione a categoria que melhor o descreve…']));
    CATEGORIES.forEach((category) => {
      const option = dom('option', { value: category.id }, [category.label]);
      if (state.candidate.category === category.id) option.setAttribute('selected', 'selected');
      categorySelect.appendChild(option);
    });

    const trainingField = FormField({ id: 'field-training', label: 'Detalhe da formação / percurso', placeholder: 'Seleccione primeiro uma categoria acima', value: state.candidate.trainingDetail });
    categorySelect.addEventListener('change', () => {
      const selected = CATEGORIES.find((category) => category.id === categorySelect.value);
      trainingField.input.placeholder = selected ? selected.hint : 'Seleccione primeiro uma categoria acima';
    });

    const experienceField = FormField({ id: 'field-experience', label: 'Anos de experiência em topografia ou área afim', placeholder: 'Ex: 3 anos', value: state.candidate.experience });
    const workplaceField = FormField({ id: 'field-workplace', label: 'Instituição / empresa onde trabalha actualmente', placeholder: 'Ex: Nome da empresa, ou "Independente"', value: state.candidate.workplace });

    const errorMessage = dom('div', {
      id: 'landing-error',
      style: 'color:var(--bad);font-size:12.5px;margin-top:-8px;margin-bottom:10px;display:none;',
    }, ['Preencha todos os campos correctamente para continuar.']);

    const form = dom('div', { style: 'margin-top:26px;' }, [
      nameField.wrapper, emailField.wrapper, phoneField.wrapper, idField.wrapper,
      categoryLabel, categorySelect, trainingField.wrapper,
      experienceField.wrapper, workplaceField.wrapper,
    ]);

    card.appendChild(form);
    card.appendChild(errorMessage);
    card.appendChild(dom('div', { class: 'btn-row' }, [
      dom('span'),
      PrimaryButton('Continuar →', () => actionSubmitLandingForm({
        nameInput: nameField.input, emailInput: emailField.input, phoneInput: phoneField.input,
        idInput: idField.input, categorySelect, trainingInput: trainingField.input,
        experienceInput: experienceField.input, workplaceInput: workplaceField.input,
        errorEl: errorMessage,
      })),
    ]));

    return dom('div', {}, [
      card,
      dom('div', { class: 'footlink' }, [
        dom('a', { onclick: actionGoToAdminGate }, ['Área da Comissão Técnica']),
      ]),
    ]);
  };

  Views.consent = function () {
    const card = dom('div', { class: 'card' });
    card.appendChild(dom('div', { class: 'eyebrow' }, ['Antes de começar']));
    card.appendChild(dom('h2', { style: 'font-size:20px;margin:6px 0 16px;' }, ['Termo de Compromisso do Candidato']));

    const termsBox = dom('div', {
      style: 'font-size:13.5px;line-height:1.65;color:var(--ink);background:#fff;border:1px solid var(--blueline-soft);' +
        'padding:16px;border-radius:var(--radius);max-height:260px;overflow-y:auto;',
    });
    [
      `Eu, ${state.candidate.name}, declaro que os dados fornecidos nesta candidatura, incluindo o meu nome completo, email e informações sobre a minha jornada profissional, são verdadeiros e completos.`,
      'Comprometo-me a realizar este exame de forma individual, sem consulta a terceiros, sem uso de ferramentas de inteligência artificial, motores de busca ou qualquer forma de auxílio externo durante a sua realização.',
      `Compreendo que cada questão tem um limite de ${CONFIG.QUESTION_DURATION_SECONDS} segundos para ser respondida. Ao esgotar-se este tempo, a questão fica automaticamente marcada como errada e o exame avança para a questão seguinte, não sendo possível voltar atrás.`,
      `Compreendo e aceito que a plataforma regista mudanças de aba ou de janela do navegador (tanto no telemóvel como no computador) durante a realização do exame, e que, ao ultrapassar ${CONFIG.TAB_SWITCH_DISQUALIFY_THRESHOLD} mudanças, serei automaticamente DESCLASSIFICADO(A), com o exame terminado de imediato e sem possibilidade de reinício.`,
      'Comprometo-me a não capturar o ecrã, gravar, fotografar, copiar ou partilhar, por qualquer meio, o conteúdo das questões deste exame. Estou ciente de que a plataforma aplica medidas técnicas de dissuasão (incluindo bloqueio de cópia/selecção de texto e uma marca de água identificativa sobreposta ao exame) e que qualquer captura ou partilha fica associada à minha identidade.',
      'Compreendo que este exame só pode ser realizado uma única vez por candidato, e que o meu nome completo e o meu email não podem ser reutilizados para um novo cadastro — qualquer tentativa de submissão repetida com o mesmo nome ou o mesmo email será automaticamente bloqueada pela plataforma.',
      'Compreendo que o resultado detalhado (aprovação/reprovação) não é apresentado de imediato nesta plataforma, sendo antes validado pela Comissão Técnica e homologado pelo Conselho de Direcção da ATTA, que comunicará o resultado oficial posteriormente.',
    ].forEach((paragraph) => termsBox.appendChild(dom('p', { style: 'margin:0 0 10px;' }, [paragraph])));
    card.appendChild(termsBox);

    const checkbox = dom('input', { type: 'checkbox', id: 'agree-checkbox' });
    checkbox.checked = state.agreedToTerms;
    const agreeButton = PrimaryButton('Confirmar e verificar elegibilidade', actionProceedAfterConsent, { id: 'agree-button' });
    agreeButton.disabled = !state.agreedToTerms;
    checkbox.addEventListener('change', () => {
      state.agreedToTerms = checkbox.checked;
      agreeButton.disabled = !checkbox.checked;
    });

    card.appendChild(dom('label', {
      style: 'display:flex;align-items:flex-start;gap:10px;margin:16px 0 6px;cursor:pointer;' +
        'text-transform:none;font-family:inherit;font-size:13.5px;font-weight:500;color:var(--ink);',
    }, [checkbox, dom('span', {}, ['Li e concordo com os termos acima, e confirmo que os meus dados estão correctos.'])]));

    card.appendChild(dom('div', { class: 'btn-row' }, [
      SecondaryButton('← Voltar', () => actionSetView('landing')),
      agreeButton,
    ]));

    return dom('div', {}, [card]);
  };

  Views.checking = function () {
    return dom('div', {}, [dom('div', { class: 'card' }, [dom('div', { class: 'loading' }, ['A verificar elegibilidade…'])])]);
  };

  Views.blocked = function () {
    const card = dom('div', { class: 'card' }, [
      dom('div', { class: 'stamp-wrap' }, [benchmarkIcon(120, '#B23A2E')]),
      dom('div', { style: 'text-align:center;' }, [
        dom('h2', { style: 'font-size:19px;color:var(--bad);margin-bottom:8px;' }, ['Exame já realizado']),
        dom('p', { style: 'font-size:13.5px;color:var(--ink-soft);max-width:420px;margin:0 auto;' }, [
          'Já existe uma submissão registada com este nome completo ou com este email. Cada candidato só pode realizar o exame de admissão uma única vez. Se acredita que isto é um erro, contacte a Comissão Técnica.',
        ]),
      ]),
      dom('div', { class: 'btn-row' }, [dom('span'), SecondaryButton('Voltar ao início', actionExitToLanding)]),
    ]);
    return dom('div', {}, [card]);
  };


  Views.exam = function () {
    const question = state.orderedQuestions[state.currentQuestionIndex];
    const section = SECTIONS.find((s) => s.id === question.section);

    const header = dom('div', { class: 'exam-head' }, [
      dom('div', {}, [dom('div', { class: 'eyebrow' }, [`Questão ${state.currentQuestionIndex + 1} de ${state.orderedQuestions.length}`])]),
      dom('div', { class: 'timer' + (state.questionTimeLeftSeconds <= CONFIG.TIMER_WARNING_SECONDS ? ' low' : ''), id: 'timer-display' }, [formatDuration(state.questionTimeLeftSeconds)]),
    ]);

    const progressTrack = dom('div', { class: 'progress-track' });
    state.orderedQuestions.forEach((q, index) => {
      let className = 'progress-dot';
      if (index === state.currentQuestionIndex) className += ' current';
      else if (state.answers[q.id] !== undefined) className += ' done';
      progressTrack.appendChild(dom('div', { class: className }));
    });

    const sectionLabel = dom('div', { class: 'section-label' }, [
      `Secção ${section.id} · ${section.name} (${section.weight}%)`,
      dom('span', { class: 'question-time-hint' }, [' · 45s por questão']),
    ]);

    const card = dom('div', { class: 'card' });
    card.appendChild(dom('div', { class: 'qtext' }, [question.text]));

    const displayOrder = state.optionOrderByQuestion[question.id];
    displayOrder.forEach((originalIndex, position) => {
      const letter = String.fromCharCode(65 + position);
      const isSelected = state.answers[question.id] === originalIndex;
      card.appendChild(dom('div', {
        class: 'option' + (isSelected ? ' selected' : ''),
        onclick: () => actionSelectAnswer(question.id, originalIndex),
      }, [
        dom('span', { class: 'letter' }, [`${letter})`]),
        dom('span', {}, [question.options[originalIndex]]),
      ]));
    });

    // Não há botão "Anterior": cada questão está sujeita ao seu próprio
    // cronómetro de 45s, pelo que recuar não faria sentido neste modelo.
    const nextOrSubmitButton = state.currentQuestionIndex < state.orderedQuestions.length - 1
      ? PrimaryButton('Seguinte →', actionGoToNextQuestion)
      : PrimaryButton('Terminar e submeter', actionConfirmSubmit);

    card.appendChild(dom('div', { class: 'btn-row' }, [dom('span'), nextOrSubmitButton]));

    const answeredCount = Object.keys(state.answers).length;
    return dom('div', { class: 'exam-security' }, [
      header, progressTrack, sectionLabel, card,
      SecurityWatermark(state.candidate.name, state.candidate.email),
      dom('div', { class: 'footlink' }, [`${answeredCount} de ${state.orderedQuestions.length} questões respondidas`]),
    ]);
  };

  Views.disqualified = function () {
    const card = dom('div', { class: 'card' }, [
      dom('div', { class: 'stamp-wrap' }, [benchmarkIcon(130, '#B23A2E')]),
      dom('div', { style: 'text-align:center;' }, [
        dom('h2', { style: 'font-size:20px;color:var(--bad);margin-bottom:8px;' }, ['Candidato desclassificado']),
        dom('p', { style: 'font-size:13.5px;color:var(--ink-soft);max-width:460px;margin:0 auto;' }, [
          `Detectámos mais do que ${CONFIG.TAB_SWITCH_DISQUALIFY_THRESHOLD} mudanças de aba/janela durante a realização do exame, o que, conforme o Termo de Compromisso aceite no início, resulta em desclassificação automática.`,
        ]),
        dom('p', { style: 'font-size:12.5px;color:var(--ink-soft);max-width:460px;margin:10px auto 0;' }, [
          'Esta ocorrência foi registada e será revista pela Comissão Técnica. Se considera que houve um engano (por exemplo, uma notificação inesperada do sistema), contacte a Comissão para esclarecimento.',
        ]),
      ]),
      dom('div', { class: 'btn-row' }, [dom('span'), SecondaryButton('Voltar ao início', actionExitToLanding)]),
    ]);
    return dom('div', {}, [card]);
  };

  Views.result = function () {
    const result = state.result;
    const banners = [];

    if (state.saveStatus === 'duplicate') {
      banners.push(Banner('error', '⚠ O servidor detectou que este nome/email já tinha uma submissão registada — esta segunda tentativa não foi gravada.'));
    } else if (state.saveStatus === 'unavailable' || state.saveStatus === 'failed') {
      banners.push(Banner('error', state.saveStatus === 'unavailable'
        ? '⚠ Este resultado NÃO foi guardado na base de dados da Comissão — o armazenamento só funciona quando a plataforma é aberta através do Claude (não em ficheiro descarregado ou noutro alojamento). Informe a Comissão.'
        : '⚠ Este resultado NÃO foi guardado — ocorreu um erro ao gravar. Informe a Comissão Técnica.'));
    } else if (state.saveStatus === 'ok') {
      banners.push(Banner('success', '✓ A sua submissão foi registada com sucesso.'));
    }

    const card = dom('div', { class: 'card' }, [
      dom('div', { class: 'stamp-wrap' }, [benchmarkIcon(140, '#0A2A3D')]),
      dom('div', { class: 'result-headline' }, [
        dom('div', { class: 'status', style: 'color:var(--ink);' }, ['Exame submetido']),
        dom('div', { class: 'pct' }, [`Obrigado, ${state.candidate.name.split(' ')[0]}. A sua prova foi recebida pela Comissão Técnica.`]),
      ]),
      dom('p', { style: 'font-size:12.5px;color:var(--ink-soft);text-align:center;max-width:480px;margin:14px auto 0;' }, [
        'O resultado oficial (aprovação/reprovação) não é revelado nesta página — será validado pela Comissão Técnica e comunicado posteriormente após homologação do Conselho de Direcção. Abaixo encontra apenas uma indicação geral do seu desempenho por área, para orientar o seu estudo.',
      ]),
    ]);

    const barsContainer = dom('div', { class: 'bars' });
    result.sections.forEach((section) => {
      const level = qualitativeLevel(section.pct);
      const row = dom('div', { class: 'bar-row' }, [
        dom('div', { class: 'bl' }, [section.name, '']),
        dom('div', { class: 'bar-track' }, [dom('div', { style: `height:100%;border-radius:5px;background:${level.color};width:100%;` })]),
        dom('div', { style: `font-size:12px;margin-top:5px;font-family:'IBM Plex Mono',monospace;color:${level.color};` }, [level.label]),
      ]);
      if (level.key !== 'green') {
        const references = STUDY_REFERENCES[section.id] || [];
        if (references.length) {
          const referenceBox = dom('div', { style: 'margin-top:6px;padding:8px 10px;background:var(--paper-2);border-radius:var(--radius);font-size:12px;color:var(--ink-soft);' });
          referenceBox.appendChild(dom('div', { style: 'font-weight:600;color:var(--ink);margin-bottom:3px;' }, ['Sugestões de leitura:']));
          references.forEach((ref) => referenceBox.appendChild(dom('div', { style: 'margin-bottom:2px;' }, [`· ${ref}`])));
          row.appendChild(referenceBox);
        }
      }
      barsContainer.appendChild(row);
    });
    card.appendChild(barsContainer);

    return dom('div', {}, [
      ...banners, card,
      dom('div', { class: 'btn-row', style: 'margin-top:16px;' }, [dom('span'), SecondaryButton('Sair', actionExitToLanding)]),
      dom('div', { class: 'footlink' }, ['Resultado preliminar de orientação. Sujeito a validação pela Comissão Técnica e homologação do Conselho de Direcção da ATTA.']),
    ]);
  };


  Views['admin-gate'] = function () {
    const codeInput = dom('input', { type: 'text', id: 'admin-code-input', placeholder: '••••••••' });
    const errorMessage = dom('div', {
      style: `color:var(--bad);font-size:12.5px;margin-bottom:6px;display:${state.adminAccessError ? 'block' : 'none'};`,
    }, [state.adminAccessError || 'Código inválido.']);

    const card = dom('div', { class: 'card' }, [
      dom('div', { class: 'eyebrow', style: 'margin-bottom:8px;' }, ['Acesso restrito']),
      dom('h2', { style: 'font-size:19px;margin-bottom:14px;' }, ['Área da Comissão Técnica']),
      dom('label', {}, ['Código de acesso']),
      codeInput,
      errorMessage,
      dom('div', { class: 'btn-row' }, [
        SecondaryButton('← Voltar', () => actionSetView('landing')),
        PrimaryButton('Entrar', () => actionTryAdminLogin(codeInput.value)),
      ]),
    ]);

    return dom('div', { class: 'admin-gate' }, [card]);
  };

  Views.admin = function () {
    const headerButtons = dom('div', { style: 'display:flex;gap:8px;' }, [
      SecondaryButton('⬇ Exportar CSV', actionExportCsv),
      SecondaryButton('Sair', () => actionSetView('landing')),
    ]);

    const card = dom('div', { class: 'card' }, [
      dom('div', { class: 'exam-head' }, [dom('h2', { style: 'font-size:19px;' }, ['Resultados dos Candidatos']), headerButtons]),
    ]);

    if (state.adminSubmissions === null) {
      card.appendChild(dom('div', { class: 'loading', id: 'admin-body' }, ['A carregar submissões…']));
      return dom('div', {}, [card]);
    }

    const body = dom('div', { id: 'admin-body' });
    if (state.adminStorageUnavailable) {
      body.appendChild(dom('div', {
        style: 'background:var(--bad-soft);border:1px solid var(--bad);color:var(--bad);padding:12px 14px;border-radius:var(--radius);font-size:13px;',
      }, ['⚠ O armazenamento de dados não está disponível neste ambiente. Isto acontece quando a plataforma é aberta fora do Claude (ficheiro descarregado, alojamento próprio, etc.). Abra-a através do link/artefacto do Claude para que os resultados dos candidatos sejam guardados e listados aqui.']));
    } else if (state.adminSubmissions.length === 0) {
      body.appendChild(dom('div', { class: 'empty' }, ['Ainda não há submissões registadas.']));
    } else {
      const categoryShortLabel = { ipcg: 'IPCG / ex-IGCA', empresa: 'Formação empresarial', estudante: 'Estudante', curso_curto: 'Curso curto', senior: 'Sénior' };
      const table = dom('table', {}, [dom('tr', {}, [
        dom('th', {}, ['Candidato']), dom('th', {}, ['Email']), dom('th', {}, ['Categoria']),
        dom('th', {}, ['Nota']), dom('th', {}, ['Estado']), dom('th', {}, ['Alertas']), dom('th', {}, ['Data']),
      ])]);
      state.adminSubmissions.forEach((submission) => {
        const alertValue = submission.tabSwitches !== undefined ? submission.tabSwitches : '—';
        const alertColor = (submission.tabSwitches || 0) > CONFIG.TAB_SWITCH_ALERT_THRESHOLD ? 'var(--bad)' : 'var(--ink-soft)';
        const categoryText = categoryShortLabel[submission.category] || (submission.categoryLabel ? submission.categoryLabel.split(' ').slice(0, 2).join(' ') : '—');
        const statusPill = submission.disqualified
          ? dom('span', { class: 'pill disqualified' }, ['Desclassificado'])
          : dom('span', { class: `pill ${submission.approved ? 'approved' : 'reproved'}` }, [submission.approved ? 'Aprovado' : 'Reprovado']);
        table.appendChild(dom('tr', {}, [
          dom('td', {}, [submission.name]),
          dom('td', { class: 'mono' }, [submission.email]),
          dom('td', { style: 'font-size:12px;' }, [categoryText]),
          dom('td', { class: 'mono' }, [`${submission.overall}%`]),
          dom('td', {}, [statusPill]),
          dom('td', { class: 'mono', style: `color:${alertColor};` }, [String(alertValue)]),
          dom('td', { class: 'mono' }, [new Date(submission.submittedAt).toLocaleString('pt-PT')]),
        ]));
        // Linha secundária com o detalhe do desempenho por secção (resumo estatístico).
        const sectionSummary = (submission.sections || [])
          .map((s) => `Secção ${s.id} = ${Math.round(s.pct)}%`)
          .join('   ·   ');
        const detailRow = dom('tr', { class: 'section-detail-row' }, [
          dom('td', { colspan: '7' }, [sectionSummary || 'Sem detalhe por secção disponível.']),
        ]);
        table.appendChild(detailRow);
      });
      body.appendChild(table);
    }
    card.appendChild(body);
    return dom('div', {}, [card]);
  };


  /* =====================================================================
   * 9. CONTROLADOR
   * render() é o único ponto que escreve no DOM a partir do estado.
   * Está envolvido em try/catch para que um erro numa vista não deixe
   * a aplicação num ecrã em branco sem qualquer explicação.
   * ===================================================================== */
  function render() {
    const root = document.getElementById('app');
    root.innerHTML = ''; // reset controlado do container raiz — não é injecção de dados externos
    root.appendChild(Topbar());

    const viewFn = Views[state.view];
    if (!viewFn) {
      console.error(`Vista desconhecida: "${state.view}".`);
      root.appendChild(dom('div', { class: 'card' }, ['Ocorreu um erro de navegação. Recarregue a página.']));
      return;
    }
    try {
      root.appendChild(viewFn());
    } catch (err) {
      console.error(`Erro ao desenhar a vista "${state.view}".`, err);
      root.appendChild(dom('div', { class: 'card' }, ['Ocorreu um erro inesperado ao mostrar este ecrã. Recarregue a página.']));
    }
  }

  /** Actualiza apenas o texto/estilo do cronómetro da questão actual, sem re-renderizar tudo (chamado a cada segundo). */
  function updateTimerDisplayOnly() {
    const timerElement = document.getElementById('timer-display');
    if (!timerElement) return;
    timerElement.textContent = formatDuration(state.questionTimeLeftSeconds);
    timerElement.className = 'timer' + (state.questionTimeLeftSeconds <= CONFIG.TIMER_WARNING_SECONDS ? ' low' : '');
  }

  function stopQuestionTimer() {
    if (state.questionTimerIntervalId) {
      clearInterval(state.questionTimerIntervalId);
      state.questionTimerIntervalId = null;
    }
  }

  /**
   * Arranca (ou reinicia) o cronómetro de 45 segundos da questão actual.
   * Ao chegar a zero, a questão fica automaticamente por responder
   * (contada como errada na correcção) e avança-se para a seguinte —
   * ou submete-se o exame, se for a última questão.
   */
  function startQuestionTimer() {
    stopQuestionTimer();
    state.questionTimeLeftSeconds = CONFIG.QUESTION_DURATION_SECONDS;
    state.questionTimerIntervalId = setInterval(() => {
      state.questionTimeLeftSeconds -= 1;
      if (state.questionTimeLeftSeconds <= 0) {
        state.questionTimeLeftSeconds = 0;
        stopQuestionTimer();
        actionAdvanceAfterTimeout();
        return;
      }
      updateTimerDisplayOnly();
    }, 1000);
  }

  /**
   * Deteção de mudanças de aba/janela (funciona tanto no browser do
   * telemóvel como no computador, através do evento visibilitychange,
   * que dispara sempre que a página deixa de estar visível — troca de
   * aba, minimizar, trocar de app no telemóvel, bloquear o ecrã, etc.).
   * Cada ocorrência é registada; ao ULTRAPASSAR o limite definido em
   * CONFIG.TAB_SWITCH_DISQUALIFY_THRESHOLD, o candidato é desclassificado
   * e o exame é terminado de imediato.
   */
  document.addEventListener('visibilitychange', () => {
    if (state.view !== 'exam' || !document.hidden) return;
    state.tabSwitches += 1;
    if (state.tabSwitches > CONFIG.TAB_SWITCH_DISQUALIFY_THRESHOLD) {
      actionDisqualifyCandidate();
    }
  });

  /**
   * MEDIDAS DE DISSUASÃO CONTRA CÓPIA E PARTILHA DO EXAME
   * -----------------------------------------------------------------
   * AVISO IMPORTANTE (honestidade técnica): nenhuma página web consegue
   * impedir de forma garantida uma captura de ecrã — isso depende do
   * sistema operativo e está fora do alcance do browser. As medidas
   * abaixo são travões reais (bloqueiam copiar/colar, selecção de
   * texto, o menu de contexto e os atalhos mais comuns) e sobretudo
   * DISSUASORAS: a marca de água (ver SecurityWatermark) torna
   * qualquer captura ou partilha identificável, o que na prática é
   * mais eficaz do que tentar bloquear tecnicamente a captura em si.
   * Todas as medidas abaixo só actuam durante state.view === 'exam',
   * para nunca interferirem com o painel da Comissão (onde é preciso
   * copiar o CSV, por exemplo).
   */
  ['copy', 'cut', 'contextmenu', 'selectstart'].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      if (state.view === 'exam') event.preventDefault();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (state.view !== 'exam') return;
    const key = (event.key || '').toLowerCase();
    const blockedWithCtrlOrCmd = ['c', 'x', 'v', 'p', 's', 'u'].includes(key);
    const isDevToolsShortcut = key === 'f12' || (event.shiftKey && (event.ctrlKey || event.metaKey) && key === 'i');
    if (((event.ctrlKey || event.metaKey) && blockedWithCtrlOrCmd) || isDevToolsShortcut) {
      event.preventDefault();
    }
  });

  // Tentativa de mitigação da tecla "Print Screen": não é possível impedir
  // a captura em si, mas ao limpar a área de transferência logo a seguir
  // reduz-se a utilidade de uma eventual captura colada noutro programa.
  document.addEventListener('keyup', (event) => {
    if (state.view !== 'exam') return;
    if (event.key === 'PrintScreen' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText('').catch(() => {});
    }
  });


  /* =====================================================================
   * 10. AÇÕES
   * Cada acção segue sempre o mesmo padrão: validar → mutar `state` →
   * chamar render() (ou, no caso do temporizador, actualizar só o
   * cronómetro). Nenhuma vista muta o estado directamente.
   * ===================================================================== */

  /** Muda de vista de forma simples, sem qualquer outro efeito secundário. */
  function actionSetView(viewName) {
    state.view = viewName;
    render();
  }

  function actionGoToAdminGate() {
    actionSetView('admin-gate');
  }

  /** Valida o formulário inicial e, se tudo correcto, avança para o Termo de Compromisso. */
  function actionSubmitLandingForm(fields) {
    const values = {
      name: fields.nameInput.value.trim(),
      email: fields.emailInput.value.trim(),
      phone: fields.phoneInput.value.trim(),
      idNumber: fields.idInput.value.trim(),
      category: fields.categorySelect.value,
      trainingDetail: fields.trainingInput.value.trim(),
      experience: fields.experienceInput.value.trim(),
      workplace: fields.workplaceInput.value.trim(),
    };
    const allFieldsFilled = Object.values(values).every(Boolean);
    if (!allFieldsFilled || !isValidEmail(values.email)) {
      fields.errorEl.textContent = !isValidEmail(values.email) && values.email
        ? 'Verifique o formato do email indicado.'
        : 'Preencha todos os campos para continuar.';
      fields.errorEl.style.display = 'block';
      return;
    }
    state.candidate = values;
    state.agreedToTerms = false;
    actionSetView('consent');
  }

  /** Após concordar com os termos, verifica duplicados antes de liberar o exame. */
  async function actionProceedAfterConsent() {
    actionSetView('checking');
    const alreadyTaken = await Storage.checkDuplicate(state.candidate.name, state.candidate.email);
    if (alreadyTaken) {
      actionSetView('blocked');
      return;
    }
    actionBeginExamSession();
  }

  /** Prepara a ordem (embaralhada, mas reprodutível) de perguntas e opções, e arranca no início. */
  function actionBeginExamSession() {
    const seed = seedFromText(state.candidate.name + state.candidate.email);
    state.orderedQuestions = shuffleDeterministic(QUESTIONS, seed);
    state.optionOrderByQuestion = {};
    state.orderedQuestions.forEach((question) => {
      state.optionOrderByQuestion[question.id] = shuffleDeterministic([0, 1, 2, 3], seed + question.id * 7);
    });
    state.answers = {};
    state.tabSwitches = 0;
    state.disqualified = false;
    state.examStartedAt = Date.now();
    actionSetView('exam');
    goToQuestionIndex(0);
  }

  /**
   * Muda para a questão indicada e reinicia o cronómetro de 45 segundos.
   * É o único ponto que avança de questão — usado tanto pelo clique em
   * "Seguinte" como pelo avanço automático ao esgotar o tempo.
   */
  function goToQuestionIndex(index) {
    state.currentQuestionIndex = index;
    render();
    startQuestionTimer();
  }

  function actionSelectAnswer(questionId, originalOptionIndex) {
    state.answers[questionId] = originalOptionIndex;
    render();
  }

  function actionGoToNextQuestion() {
    if (state.currentQuestionIndex < state.orderedQuestions.length - 1) {
      goToQuestionIndex(state.currentQuestionIndex + 1);
    }
  }

  /** Chamado pelo cronómetro da questão ao chegar a zero: a questão fica
   *  por responder (contada como errada) e avança-se automaticamente. */
  function actionAdvanceAfterTimeout() {
    if (state.currentQuestionIndex < state.orderedQuestions.length - 1) {
      goToQuestionIndex(state.currentQuestionIndex + 1);
    } else {
      actionSubmitExam();
    }
  }

  function actionConfirmSubmit() {
    const answeredCount = Object.keys(state.answers).length;
    if (answeredCount < state.orderedQuestions.length) {
      const proceed = window.confirm(
        `Respondeu a ${answeredCount} de ${state.orderedQuestions.length} questões. As restantes ficam marcadas como erradas. Deseja submeter mesmo assim?`
      );
      if (!proceed) return;
    }
    actionSubmitExam();
  }

  /** Corrige o exame, mostra o ecrã de resultado, e só depois tenta gravar (a UI não fica bloqueada à espera da rede). */
  async function actionSubmitExam() {
    stopQuestionTimer();
    const timeUsedSec = Math.round((Date.now() - (state.examStartedAt || Date.now())) / 1000);
    const scored = scoreExam(state.answers, state.orderedQuestions, state.tabSwitches, timeUsedSec);

    state.result = {
      name: state.candidate.name,
      email: state.candidate.email,
      phone: state.candidate.phone,
      idNumber: state.candidate.idNumber,
      category: state.candidate.category,
      categoryLabel: (CATEGORIES.find((c) => c.id === state.candidate.category) || {}).label || state.candidate.category,
      trainingDetail: state.candidate.trainingDetail,
      experience: state.candidate.experience,
      workplace: state.candidate.workplace,
      submittedAt: new Date().toISOString(),
      disqualified: false,
      ...scored,
    };
    actionSetView('result');

    state.saveStatus = await Storage.save(state.result);
    render();
  }

  /**
   * Termina o exame imediatamente por desclassificação (mudanças de aba
   * acima do limite permitido). Corrige o que foi respondido até este
   * momento apenas para efeitos de registo — a aprovação é sempre
   * forçada a "não aprovado", independentemente da nota calculada.
   */
  async function actionDisqualifyCandidate() {
    stopQuestionTimer();
    state.disqualified = true;
    const timeUsedSec = Math.round((Date.now() - (state.examStartedAt || Date.now())) / 1000);
    const scored = scoreExam(state.answers, state.orderedQuestions, state.tabSwitches, timeUsedSec);

    state.result = {
      name: state.candidate.name,
      email: state.candidate.email,
      phone: state.candidate.phone,
      idNumber: state.candidate.idNumber,
      category: state.candidate.category,
      categoryLabel: (CATEGORIES.find((c) => c.id === state.candidate.category) || {}).label || state.candidate.category,
      trainingDetail: state.candidate.trainingDetail,
      experience: state.candidate.experience,
      workplace: state.candidate.workplace,
      submittedAt: new Date().toISOString(),
      disqualified: true,
      ...scored,
      approved: false, // uma desclassificação nunca resulta em aprovação, independentemente da nota
    };
    actionSetView('disqualified');

    state.saveStatus = await Storage.save(state.result);
    render();
  }

  /** Repõe a aplicação ao estado inicial (usado no botão "Sair" e após bloqueio de duplicado). */
  function actionExitToLanding() {
    stopQuestionTimer();
    state = createInitialState();
    render();
  }

  function actionTryAdminLogin(codeValue) {
    if (codeValue.trim() === CONFIG.ADMIN_ACCESS_CODE) {
      state.adminAccessError = '';
      actionSetView('admin');
      actionLoadAdminSubmissions();
    } else {
      state.adminAccessError = 'Código inválido.';
      render();
    }
  }

  async function actionLoadAdminSubmissions() {
    const { items, unavailable } = await Storage.listAll();
    items.sort((a, b) => b.overall - a.overall);
    state.adminSubmissions = items;
    state.adminStorageUnavailable = unavailable;
    render();
  }


  /* =====================================================================
   * Exportação CSV (painel da Comissão)
   * Isolada num único local — a lista de colunas está definida apenas
   * aqui, evitando o desalinhamento entre a tabela e o CSV que existiu
   * na versão anterior quando novos campos foram adicionados.
   * ===================================================================== */
  const CSV_COLUMNS = [
    { header: 'Nome', get: (r) => r.name },
    { header: 'Email', get: (r) => r.email },
    { header: 'Telefone', get: (r) => r.phone || '' },
    { header: 'Matrícula/ID', get: (r) => r.idNumber || '' },
    { header: 'Categoria', get: (r) => r.categoryLabel || r.category || '' },
    { header: 'Detalhe da Formação', get: (r) => r.trainingDetail || '' },
    { header: 'Experiência', get: (r) => r.experience || '' },
    { header: 'Instituição/Empresa', get: (r) => r.workplace || '' },
    { header: 'Nota Geral (%)', get: (r) => r.overall },
    { header: 'Estado', get: (r) => (r.disqualified ? 'Desclassificado' : (r.approved ? 'Aprovado' : 'Reprovado')) },
    { header: 'Mudanças de Aba', get: (r) => (r.tabSwitches !== undefined ? r.tabSwitches : '') },
    { header: 'Data de Submissão', get: (r) => new Date(r.submittedAt).toLocaleString('pt-PT') },
    { header: 'Tempo Usado (s)', get: (r) => r.timeUsedSec },
  ];

  function escapeCsvCell(value) {
    const text = String(value).replace(/"/g, '""');
    return /[",;\n]/.test(text) ? `"${text}"` : text;
  }

  function buildCsv(submissions) {
    const headers = CSV_COLUMNS.map((col) => col.header).concat(SECTIONS.map((s) => `${s.name} (%)`));
    const rows = [headers];
    submissions.forEach((submission) => {
      const row = CSV_COLUMNS.map((col) => col.get(submission));
      SECTIONS.forEach((section) => {
        const sectionResult = submission.sections.find((s) => s.id === section.id);
        row.push(sectionResult ? Math.round(sectionResult.pct) : '');
      });
      rows.push(row);
    });
    return rows.map((row) => row.map(escapeCsvCell).join(';')).join('\n');
  }

  function actionExportCsv() {
    if (!state.adminSubmissions || state.adminSubmissions.length === 0) return;
    showCsvExportModal(buildCsv(state.adminSubmissions));
  }

  /**
   * Mostra o CSV num modal com opção de copiar ou tentar descarregar.
   * O download automático via <a download> é bloqueado no sandbox de
   * artefactos do Claude — por isso o modal oferece sempre "Copiar"
   * como alternativa garantida, e uma tentativa de download como bónus.
   */
  function showCsvExportModal(csvText) {
    const textarea = dom('textarea', { id: 'csv-export-textarea', class: 'csv-textarea', readonly: 'readonly' });
    textarea.value = csvText;

    const statusLabel = dom('span', { style: 'font-size:12px;color:var(--good);margin-right:auto;' }, ['']);

    function closeModal() {
      const overlayEl = document.getElementById('csv-modal-overlay');
      if (overlayEl) overlayEl.remove();
    }

    function copyToClipboard() {
      textarea.focus();
      textarea.select();
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textarea.value);
          copied = true;
        } else {
          copied = document.execCommand('copy');
        }
      } catch (err) {
        console.error('Falha ao copiar CSV para a área de transferência.', err);
        try { copied = document.execCommand('copy'); } catch (err2) { copied = false; }
      }
      statusLabel.textContent = copied ? 'Copiado ✓' : 'Não foi possível copiar automaticamente — seleccione o texto manualmente.';
    }

    function attemptDownload() {
      try {
        const blob = new Blob(['\uFEFF' + textarea.value], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const newWindow = window.open(url, '_blank');
        statusLabel.textContent = newWindow
          ? 'Aberto numa nova aba — guarde a partir daí (Ctrl/Cmd+S).'
          : 'O browser bloqueou a nova aba. Use "Copiar" e cole num ficheiro.';
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {
        console.error('Falha ao tentar descarregar o CSV.', err);
        statusLabel.textContent = 'Descarregamento indisponível aqui — use "Copiar".';
      }
    }

    const modalBox = dom('div', { class: 'modal-box' }, [
      dom('h3', { style: 'font-size:16px;margin-bottom:6px;' }, ['Exportar resultados (CSV)']),
      dom('p', { style: 'font-size:12.5px;color:var(--ink-soft);margin:0 0 12px;' }, [
        'Copie o texto abaixo e cole num ficheiro .csv, ou cole directamente numa folha do Excel/Google Sheets (separador ";"). Também pode tentar descarregar directamente.',
      ]),
      textarea,
      dom('div', { class: 'btn-row' }, [statusLabel, SecondaryButton('Fechar', closeModal), SecondaryButton('⬇ Tentar descarregar', attemptDownload), PrimaryButton('Copiar', copyToClipboard)]),
    ]);

    const overlay = dom('div', { class: 'modal-overlay', id: 'csv-modal-overlay' }, [modalBox]);
    document.body.appendChild(overlay);
    textarea.focus();
    textarea.select();
  }

  /* =====================================================================
   * 11. INICIALIZAÇÃO
   * ===================================================================== */
  render();

})();