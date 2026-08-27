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
    QUESTION_DURATION_SECONDS: 40,

    /** A partir de quantos segundos restantes o cronómetro da questão fica "em alerta". */
    TIMER_WARNING_SECONDS: 10,

    /** Tempo máximo (ms) que uma sessão de exame interrompida (queda de
     *  rede ou recarregamento da página) pode ficar parada e ainda ser
     *  retomada automaticamente. Passado este limite, a sessão guardada
     *  é descartada e o candidato recomeça do início — evita retomar
     *  sessões muito antigas e possivelmente já sem sentido. */
    RESUME_MAX_AGE_MS: 2 * 60 * 60 * 1000, // 2 horas

    /** Nº de questões sorteadas (proporcionalmente pelas 5 secções) para
     *  compor CADA exame individual — o banco completo tem 500 questões,
     *  mas cada candidato responde apenas a este número, escolhidas ao
     *  acaso, o que gera uma prova diferente por candidato. */
    QUESTIONS_PER_EXAM: 20,

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

    /**
     * Nota mínima geral (ponderada pelas 5 secções) para aprovação.
     * Desde a revisão de Agosto de 2026, a aprovação depende SÓ desta
     * nota geral — deixou de existir um mínimo obrigatório por secção,
     * para não reprovar em bloco candidatos com um bom desempenho global
     * mas alguma fragilidade pontual numa única secção.
     */
    APPROVAL_MIN_OVERALL_PERCENT: 60,

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
    "text": "Um ângulo foi lido no instrumento como 192°00'05\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "192.0000°",
      "192.0014°",
      "192.0833°",
      "193.0014°"
    ],
    "answer": 1
  },
  {
    "id": 2,
    "section": 1,
    "text": "Na taqueometria, a leitura do fio médio (ou nível médio) da mira corresponde, em condições ideais, a:",
    "options": [
      "A distância horizontal directamente, sem qualquer cálculo adicional.",
      "Aproximadamente a média entre as leituras dos fios estadimétricos superior e inferior, servindo como verificação da leitura.",
      "A altura total da mira, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector, conforme os manuais técnicos da área.",
      "Um valor sempre igual a zero."
    ],
    "answer": 1
  },
  {
    "id": 3,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 93°05'54\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "94.0983°",
      "93.0833°",
      "93.9000°",
      "93.0983°"
    ],
    "answer": 3
  },
  {
    "id": 4,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.225 m e o fio superior marca 1.440 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "10.75 m",
      "43.00 m",
      "22.50 m",
      "21.50 m"
    ],
    "answer": 3
  },
  {
    "id": 5,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 122°52'37\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "122.8667°",
      "122.6167°",
      "123.8769°",
      "122.8769°"
    ],
    "answer": 3
  },
  {
    "id": 6,
    "section": 1,
    "text": "As coordenadas rectangulares (cartesianas) de um ponto, num levantamento topográfico, são normalmente designadas por:",
    "options": [
      "Distância e azimute a partir de uma origem.",
      "Coordenadas Norte (N) e Este (E), ou X e Y, referidas a um sistema de eixos ortogonais.",
      "Apenas a altitude do ponto, sem que seja necessária qualquer verificação ou confirmação adicional posterior.",
      "O número do vértice na caderneta de campo."
    ],
    "answer": 1
  },
  {
    "id": 7,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 299°08'46\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "299.1333°",
      "299.7667°",
      "299.1461°",
      "300.1461°"
    ],
    "answer": 2
  },
  {
    "id": 8,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 88°54'58\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "88.9000°",
      "88.9667°",
      "88.9161°",
      "89.9161°"
    ],
    "answer": 2
  },
  {
    "id": 9,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.685 m e o fio superior marca 2.047 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "72.40 m",
      "18.10 m",
      "36.20 m",
      "37.20 m"
    ],
    "answer": 2
  },
  {
    "id": 10,
    "section": 1,
    "text": "O Rumo (ou \"bearing\") de uma direcção distingue-se do Azimute porque:",
    "options": [
      "É medido a partir do Norte ou do Sul (o mais próximo), no sentido do quadrante (E ou W), variando entre 0° e 90°, sendo necessário indicar o quadrante.",
      "Não tem qualquer relação com a orientação geográfica, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina, independentemente da experiência do operador.",
      "É sempre igual ao Azimute, apenas com outro nome.",
      "Só pode ser medido com teodolito, nunca com estação total."
    ],
    "answer": 0
  },
  {
    "id": 11,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 291°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 21°",
      "Rumo SE 69°, sendo esta a prática mais comum em campo.",
      "Rumo NW 69°",
      "Rumo NW 79°"
    ],
    "answer": 2
  },
  {
    "id": 12,
    "section": 1,
    "text": "Num levantamento taqueométrico clássico com mira vertical, a constante estadimétrica (K) do instrumento é tipicamente:",
    "options": [
      "Irrelevante para o cálculo de distâncias.",
      "Sempre igual à distância medida.",
      "Igual a 1, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector, independentemente da experiência do operador.",
      "Igual a 100, sendo a distância horizontal aproximadamente K vezes a diferença entre as leituras dos fios estadimétricos superior e inferior."
    ],
    "answer": 3
  },
  {
    "id": 13,
    "section": 1,
    "text": "As coordenadas polares de um ponto, relativamente a uma estação, são definidas por:",
    "options": [
      "Um ângulo (azimute ou rumo) e uma distância, a partir do ponto de estação.",
      "A soma de todos os ângulos internos da poligonal, independentemente da escala do levantamento.",
      "Apenas a cota do ponto.",
      "Duas distâncias perpendiculares entre si."
    ],
    "answer": 0
  },
  {
    "id": 14,
    "section": 1,
    "text": "Uma Rede Geodésica de referência serve, entre outras funções, para:",
    "options": [
      "Ser usada exclusivamente em levantamentos batimétricos.",
      "Definir apenas os limites de propriedades privadas.",
      "Fornecer pontos de coordenadas conhecidas e precisas que servem de apoio aos levantamentos topográficos locais.",
      "Substituir a necessidade de qualquer levantamento de campo, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector."
    ],
    "answer": 2
  },
  {
    "id": 15,
    "section": 1,
    "text": "Um \"croqui\" de campo, em topografia, é:",
    "options": [
      "Um cálculo preciso de coordenadas.",
      "Um desenho esquemático, geralmente à mão levantada, feito no local, que regista a disposição dos pontos e detalhes observados.",
      "Um relatório final assinado por um engenheiro.",
      "Um tipo de erro instrumental, conforme geralmente indicado nos manuais técnicos de referência da área, conforme o entendimento tradicional sobre a matéria."
    ],
    "answer": 1
  },
  {
    "id": 16,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.515 m e o fio superior marca 2.077 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "112.40 m",
      "57.20 m",
      "56.20 m",
      "28.10 m"
    ],
    "answer": 2
  },
  {
    "id": 17,
    "section": 1,
    "text": "Uma Referência de Nível (RN) ou \"Bench Mark\" é:",
    "options": [
      "Um ponto de coordenadas planimétricas apenas, sem cota associada.",
      "Um tipo de erro sistemático do nível óptico.",
      "O nome dado ao operador responsável pelo nivelamento.",
      "Um ponto materializado no terreno, de altitude conhecida e estável, utilizado como referência para trabalhos de nivelamento."
    ],
    "answer": 3
  },
  {
    "id": 18,
    "section": 1,
    "text": "Ao converter uma distância inclinada em distância horizontal, um erro no ângulo vertical medido provoca:",
    "options": [
      "Um erro que só ocorre se o instrumento não tiver bolha esférica.",
      "Nenhum efeito, pois a distância horizontal não depende do ângulo vertical.",
      "Um erro apenas na determinação da cota, nunca na distância, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo.",
      "Um erro proporcional na distância horizontal calculada, sendo esse efeito mais significativo em terrenos de maior declive."
    ],
    "answer": 3
  },
  {
    "id": 19,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 119°18'28\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "119.3078°",
      "119.4667°",
      "119.3000°",
      "120.3078°"
    ],
    "answer": 0
  },
  {
    "id": 20,
    "section": 1,
    "text": "Uma poligonal fechada tem 12 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1980°",
      "1800°",
      "900°",
      "2160°"
    ],
    "answer": 1
  },
  {
    "id": 21,
    "section": 1,
    "text": "Uma poligonal fechada tem 7 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "900°",
      "450°",
      "1080°",
      "1260°"
    ],
    "answer": 0
  },
  {
    "id": 22,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 195°47'16\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "195.7833°",
      "196.7878°",
      "195.7878°",
      "195.2667°"
    ],
    "answer": 2
  },
  {
    "id": 23,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.039 m e o fio superior marca 1.321 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "28.20 m",
      "56.40 m",
      "14.10 m",
      "29.20 m"
    ],
    "answer": 0
  },
  {
    "id": 24,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.299 m e o fio superior marca 1.615 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "32.60 m",
      "63.20 m",
      "15.80 m",
      "31.60 m"
    ],
    "answer": 3
  },
  {
    "id": 25,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.212 m e o fio superior marca 1.695 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "48.30 m",
      "24.15 m",
      "49.30 m",
      "96.60 m"
    ],
    "answer": 0
  },
  {
    "id": 26,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 30°37'41\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "30.6833°",
      "30.6167°",
      "30.6281°",
      "31.6281°"
    ],
    "answer": 2
  },
  {
    "id": 27,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 275°39'38\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "276.6606°",
      "275.6500°",
      "275.6333°",
      "275.6606°"
    ],
    "answer": 3
  },
  {
    "id": 28,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 218°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SW 48°",
      "Rumo SW 38°",
      "Rumo SW 52°",
      "Rumo NE 38°, conforme o entendimento tradicional sobre a matéria."
    ],
    "answer": 1
  },
  {
    "id": 29,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.360 m e o fio superior marca 1.764 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "40.40 m",
      "41.40 m",
      "20.20 m",
      "80.80 m"
    ],
    "answer": 0
  },
  {
    "id": 30,
    "section": 1,
    "text": "Uma poligonal fechada tem 6 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "360°",
      "720°",
      "900°",
      "1080°"
    ],
    "answer": 1
  },
  {
    "id": 31,
    "section": 1,
    "text": "Um ângulo zenital distingue-se de um ângulo vertical de inclinação porque:",
    "options": [
      "São exactamente o mesmo ângulo, apenas com nomes diferentes, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo.",
      "É medido a partir do zénite (direcção vertical ascendente), enquanto o ângulo de inclinação é medido a partir do plano horizontal.",
      "O ângulo zenital só existe em levantamentos subterrâneos.",
      "Não têm qualquer relação matemática entre si."
    ],
    "answer": 1
  },
  {
    "id": 32,
    "section": 1,
    "text": "Um ângulo horizontal, em topografia, é medido:",
    "options": [
      "No plano vertical, entre o horizonte e o ponto observado.",
      "No plano horizontal, entre duas direcções (visadas) a partir de um vértice.",
      "Apenas com recurso a GPS.",
      "Sempre em relação ao zénite do observador, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector."
    ],
    "answer": 1
  },
  {
    "id": 33,
    "section": 1,
    "text": "A escolha adequada dos pontos de apoio (vértices de poligonal) num levantamento deve considerar principalmente:",
    "options": [
      "A intervisibilidade entre pontos consecutivos, a estabilidade do terreno e a cobertura adequada da área a levantar.",
      "Apenas a facilidade de acesso ao ponto, ignorando a intervisibilidade, sendo este o procedimento historicamente seguido pela generalidade da profissão.",
      "A proximidade a estradas asfaltadas, exclusivamente.",
      "O menor número possível de pontos, independentemente da precisão exigida."
    ],
    "answer": 0
  },
  {
    "id": 34,
    "section": 1,
    "text": "A declinação magnética corresponde a:",
    "options": [
      "O erro de colimação de um teodolito.",
      "A diferença de altitude entre dois pontos.",
      "A distância entre dois meridianos consecutivos.",
      "O ângulo entre o Norte verdadeiro (geográfico) e o Norte magnético, num determinado local e momento."
    ],
    "answer": 3
  },
  {
    "id": 35,
    "section": 1,
    "text": "Uma poligonal fechada tem 5 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "720°",
      "900°",
      "270°",
      "540°"
    ],
    "answer": 3
  },
  {
    "id": 36,
    "section": 1,
    "text": "A conversão de coordenadas polares para rectangulares utiliza-se de:",
    "options": [
      "Apenas o teorema de Pitágoras, sem qualquer função trigonométrica.",
      "Uma simples soma aritmética entre o ângulo e a distância, independentemente do equipamento utilizado.",
      "Uma tabela de conversão fixa, independente do ângulo.",
      "Funções trigonométricas seno e cosseno do ângulo, multiplicadas pela distância."
    ],
    "answer": 3
  },
  {
    "id": 37,
    "section": 1,
    "text": "A distância horizontal, em topografia, é obtida a partir da distância inclinada (medida directamente no terreno) através de:",
    "options": [
      "Uma redução que não depende do ângulo vertical medido.",
      "Uma redução trigonométrica, multiplicando a distância inclinada pelo cosseno do ângulo de inclinação (vertical).",
      "Multiplicação directa pela escala do mapa.",
      "Uma simples soma da distância inclinada com a diferença de cota, conforme geralmente indicado nos manuais técnicos de referência da área."
    ],
    "answer": 1
  },
  {
    "id": 38,
    "section": 1,
    "text": "O levantamento taqueométrico é particularmente vantajoso em:",
    "options": [
      "Cálculo directo de volumes de betão em obras.",
      "Determinação exclusiva de limites de propriedade em litígio.",
      "Levantamentos de grande precisão geodésica de referência nacional, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina.",
      "Levantamentos de detalhe de terrenos, como a determinação de pontos para elaboração de plantas topográficas com curvas de nível."
    ],
    "answer": 3
  },
  {
    "id": 39,
    "section": 1,
    "text": "Um erro grosseiro (ou falta), em topografia, resulta tipicamente de:",
    "options": [
      "Variações normais e inevitáveis nas condições atmosféricas, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Limitações inerentes à precisão do instrumento utilizado.",
      "Um engano do operador, como leitura ou anotação incorrecta, e deve ser detectado e eliminado, não compensado estatisticamente.",
      "Uma característica sempre presente e aceitável em qualquer levantamento."
    ],
    "answer": 2
  },
  {
    "id": 40,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 134°45'40\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "134.7611°",
      "134.7500°",
      "134.6667°",
      "135.7611°"
    ],
    "answer": 0
  },
  {
    "id": 41,
    "section": 1,
    "text": "O ponto de estação, num levantamento com estação total, corresponde a:",
    "options": [
      "O ponto final da poligonal, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "O local onde o instrumento está fisicamente colocado e a partir do qual são feitas as observações.",
      "Qualquer ponto observado no terreno.",
      "Um ponto exclusivamente usado em nivelamento."
    ],
    "answer": 1
  },
  {
    "id": 42,
    "section": 1,
    "text": "O nivelamento geométrico é normalmente considerado mais preciso do que o nivelamento trigonométrico porque:",
    "options": [
      "Baseia-se em visadas horizontais curtas e na leitura directa de miras, minimizando a propagação de erros angulares.",
      "Usa apenas GPS, o que é sempre mais rigoroso.",
      "É realizado apenas em uma única estação, sem necessidade de mudanças de posição.",
      "Não necessita de qualquer verificação instrumental, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico."
    ],
    "answer": 0
  },
  {
    "id": 43,
    "section": 1,
    "text": "Distinguir precisão de exactidão é importante porque:",
    "options": [
      "A precisão só pode ser avaliada com uma única medição.",
      "Um conjunto de medições pode ser preciso (resultados próximos entre si) sem ser exacto (próximo do valor verdadeiro), caso exista um erro sistemático não corrigido.",
      "São sinónimos, pelo que a distinção é irrelevante na prática.",
      "A exactidão só se aplica a instrumentos electrónicos, sem que seja necessária qualquer verificação ou confirmação adicional posterior, conforme adoptado na maioria dos projectos."
    ],
    "answer": 1
  },
  {
    "id": 44,
    "section": 1,
    "text": "No nivelamento geométrico composto (com várias estações), o desnível total entre o ponto inicial e o final é obtido por:",
    "options": [
      "A soma de todas as leituras de ré, sem considerar as leituras de vante.",
      "O produto entre o número de estações e a distância total percorrida, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector.",
      "A diferença entre a soma das leituras de ré e a soma das leituras de vante ao longo de todo o caminho de nivelamento.",
      "A média aritmética simples de todas as leituras efectuadas."
    ],
    "answer": 2
  },
  {
    "id": 45,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 105°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SE 75°",
      "Rumo SE 15°",
      "Rumo SE 85°",
      "Rumo NW 75°"
    ],
    "answer": 0
  },
  {
    "id": 46,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 309°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 61°",
      "Rumo SE 51°",
      "Rumo NW 39°, independentemente do equipamento utilizado.",
      "Rumo NW 51°"
    ],
    "answer": 3
  },
  {
    "id": 47,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.075 m e o fio superior marca 1.515 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "22.00 m",
      "44.00 m",
      "45.00 m",
      "88.00 m"
    ],
    "answer": 1
  },
  {
    "id": 48,
    "section": 1,
    "text": "Em condições de longa distância, a correcção de esfericidade e refracção é aplicada porque:",
    "options": [
      "A curvatura da Terra e a refracção atmosférica afectam as visadas de longa distância, introduzindo um erro sistemático que deve ser corrigido.",
      "Apenas afecta medições realizadas à noite.",
      "A Terra é plana e por isso não há necessidade de qualquer correcção, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector.",
      "É uma correcção exclusiva de levantamentos com GPS."
    ],
    "answer": 0
  },
  {
    "id": 49,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 331°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 61°",
      "Rumo SE 29°",
      "Rumo NW 29°",
      "Rumo NW 39°"
    ],
    "answer": 2
  },
  {
    "id": 50,
    "section": 1,
    "text": "A distância reduzida ao elipsóide (ou ao nível do mar), utilizada em trabalhos geodésicos de maior rigor, é necessária porque:",
    "options": [
      "Substitui a necessidade de qualquer nivelamento.",
      "É sempre igual à distância medida directamente no terreno, sem qualquer correcção, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector, independentemente das condições do levantamento.",
      "Só é relevante para levantamentos batimétricos.",
      "As distâncias medidas em altitude elevada sofrem uma pequena deformação em relação à superfície de referência, que deve ser corrigida em projectos de grande precisão ou extensão."
    ],
    "answer": 3
  },
  {
    "id": 51,
    "section": 1,
    "text": "O nivelamento trigonométrico é especialmente útil em situações de:",
    "options": [
      "Terrenos acidentados ou grandes desníveis, onde seria impraticável o nivelamento geométrico estação a estação.",
      "Cálculo directo de áreas de polígonos, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Terrenos muito planos e de curtas distâncias, onde o nivelamento geométrico já é suficiente.",
      "Levantamentos exclusivamente em interiores de edifícios."
    ],
    "answer": 0
  },
  {
    "id": 52,
    "section": 1,
    "text": "Em topografia, um erro sistemático caracteriza-se por:",
    "options": [
      "Ser sempre maior do que a tolerância admissível.",
      "Ter uma causa identificável e constante (por exemplo, um erro de calibração do instrumento), afectando as medições sempre no mesmo sentido.",
      "Ocorrer de forma aleatória e imprevisível, sem causa identificável.",
      "Ser eliminado automaticamente pelo simples facto de repetir a medição."
    ],
    "answer": 1
  },
  {
    "id": 53,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 132°08'56\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "133.1489°",
      "132.1489°",
      "132.1333°",
      "132.9333°"
    ],
    "answer": 1
  },
  {
    "id": 54,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 22°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NE 68°",
      "Rumo NE 22°",
      "Rumo NE 32°",
      "Rumo SW 22°"
    ],
    "answer": 1
  },
  {
    "id": 55,
    "section": 1,
    "text": "A materialização de um ponto topográfico no terreno (por exemplo, com um piquete ou marco) serve para:",
    "options": [
      "Assinalar fisicamente a posição do ponto, permitindo a sua localização e reocupação futura.",
      "Facilitar cálculos matemáticos apenas em escritório.",
      "Indicar exclusivamente limites administrativos nacionais.",
      "Substituir a necessidade de qualquer coordenada."
    ],
    "answer": 0
  },
  {
    "id": 56,
    "section": 1,
    "text": "Uma poligonal fechada tem 12 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "2160°",
      "1980°",
      "1800°",
      "900°"
    ],
    "answer": 2
  },
  {
    "id": 57,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 130°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SE 60°, independentemente da escala do levantamento.",
      "Rumo SE 50°",
      "Rumo SE 40°",
      "Rumo NW 50°"
    ],
    "answer": 1
  },
  {
    "id": 58,
    "section": 1,
    "text": "A tolerância angular admissível numa poligonal topográfica costuma ser expressa em função de:",
    "options": [
      "A cor do terreno observado.",
      "Uma fórmula que relaciona a precisão do instrumento com o número de vértices ou estações da poligonal (por exemplo, do tipo a√n).",
      "O horário do dia em que a medição foi efectuada.",
      "Apenas o número de lados da poligonal, através de uma constante fixa dada pelo fabricante do instrumento, independentemente da experiência do operador."
    ],
    "answer": 1
  },
  {
    "id": 59,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 253°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SW 83°",
      "Rumo NE 73°",
      "Rumo SW 73°",
      "Rumo SW 17°, independentemente da experiência do operador."
    ],
    "answer": 2
  },
  {
    "id": 60,
    "section": 1,
    "text": "Uma poligonal fechada tem 6 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "900°",
      "1080°",
      "360°",
      "720°"
    ],
    "answer": 3
  },
  {
    "id": 61,
    "section": 1,
    "text": "A origem de um sistema de coordenadas locais, num levantamento topográfico, é normalmente:",
    "options": [
      "Um ponto arbitrário ou de coordenadas conhecidas, escolhido para facilitar os cálculos e a representação da área de trabalho.",
      "Sempre o centro geométrico da Terra, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Irrelevante para o cálculo de áreas.",
      "Obrigatoriamente localizada no equador."
    ],
    "answer": 0
  },
  {
    "id": 62,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 125°22'53\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "125.3667°",
      "126.3814°",
      "125.3814°",
      "125.8833°"
    ],
    "answer": 2
  },
  {
    "id": 63,
    "section": 1,
    "text": "Uma poligonal fechada tem 4 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "360°",
      "720°",
      "180°",
      "540°"
    ],
    "answer": 0
  },
  {
    "id": 64,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.078 m e o fio superior marca 1.432 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "36.40 m",
      "35.40 m",
      "17.70 m",
      "70.80 m"
    ],
    "answer": 1
  },
  {
    "id": 65,
    "section": 1,
    "text": "Uma poligonal fechada tem 7 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "900°",
      "1260°",
      "1080°",
      "450°"
    ],
    "answer": 0
  },
  {
    "id": 66,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 268°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SW 2°",
      "Rumo SW 89°",
      "Rumo NE 88°",
      "Rumo SW 88°"
    ],
    "answer": 3
  },
  {
    "id": 67,
    "section": 1,
    "text": "O termo \"caderneta de campo\", em topografia, refere-se a:",
    "options": [
      "A designação do relatório final entregue ao cliente.",
      "Um documento legal de propriedade do terreno.",
      "Um tipo específico de instrumento óptico.",
      "O registo (em papel ou digital) das observações, leituras e croquis efectuados durante o trabalho de campo."
    ],
    "answer": 3
  },
  {
    "id": 68,
    "section": 1,
    "text": "Uma poligonal fechada tem 10 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1620°",
      "720°",
      "1440°",
      "1800°"
    ],
    "answer": 2
  },
  {
    "id": 69,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.707 m e o fio superior marca 1.897 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "20.00 m",
      "38.00 m",
      "9.50 m",
      "19.00 m"
    ],
    "answer": 3
  },
  {
    "id": 70,
    "section": 1,
    "text": "A trilateração distingue-se da triangulação clássica porque:",
    "options": [
      "Não utiliza qualquer tipo de rede de pontos.",
      "É aplicável apenas a levantamentos subaquáticos.",
      "Baseia-se na medição de distâncias entre os vértices da rede, em vez de ângulos.",
      "Dispensa a necessidade de qualquer ajustamento posterior, conforme adoptado na maioria dos projectos."
    ],
    "answer": 2
  },
  {
    "id": 71,
    "section": 1,
    "text": "A Topografia distingue-se da Geodesia principalmente porque:",
    "options": [
      "Não existe qualquer diferença entre as duas disciplinas.",
      "A Topografia só é usada em meio urbano e a Geodesia só em meio rural, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "A Geodesia não utiliza coordenadas, ao contrário da Topografia.",
      "A Topografia estuda áreas relativamente pequenas, considerando a Terra plana; a Geodesia estuda grandes extensões, considerando a curvatura terrestre."
    ],
    "answer": 3
  },
  {
    "id": 72,
    "section": 1,
    "text": "Uma poligonal fechada tem 12 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1800°",
      "2160°",
      "900°",
      "1980°"
    ],
    "answer": 0
  },
  {
    "id": 73,
    "section": 1,
    "text": "A medição indirecta de distâncias por taqueometria (estadimetria) baseia-se em:",
    "options": [
      "Medir directamente a distância com fita métrica entre dois pontos, sendo esta uma prática amplamente disseminada entre topógrafos com maior experiência.",
      "Calcular a distância a partir das leituras dos fios estadimétricos (superior e inferior) na mira e da constante estadimétrica do instrumento.",
      "Usar exclusivamente sinais de rádio entre dois receptores.",
      "Comparar sombras projectadas ao meio-dia solar."
    ],
    "answer": 1
  },
  {
    "id": 74,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 124°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SE 66°",
      "Rumo SE 56°",
      "Rumo NW 56°, tal como recomendado pelos fabricantes.",
      "Rumo SE 34°"
    ],
    "answer": 1
  },
  {
    "id": 75,
    "section": 1,
    "text": "A taqueometria é um método topográfico que permite:",
    "options": [
      "Apenas a medição de ângulos, sem qualquer determinação de distâncias.",
      "Substituir por completo a necessidade de qualquer nivelamento geométrico.",
      "A determinação simultânea e relativamente rápida de distâncias, ângulos e desníveis, a partir de uma única estação.",
      "Exclusivamente a criação de mapas temáticos."
    ],
    "answer": 2
  },
  {
    "id": 76,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 159°38'29\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "159.4833°",
      "159.6414°",
      "159.6333°",
      "160.6414°"
    ],
    "answer": 1
  },
  {
    "id": 77,
    "section": 1,
    "text": "Uma poligonal fechada tem 9 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "630°",
      "1620°",
      "1440°",
      "1260°"
    ],
    "answer": 3
  },
  {
    "id": 78,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 128°21'01\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "129.3503°",
      "128.3500°",
      "128.3503°",
      "128.0167°"
    ],
    "answer": 2
  },
  {
    "id": 79,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.118 m e o fio superior marca 1.388 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "28.00 m",
      "13.50 m",
      "27.00 m",
      "54.00 m"
    ],
    "answer": 2
  },
  {
    "id": 80,
    "section": 1,
    "text": "Num circuito de nivelamento fechado (que parte e regressa ao mesmo ponto), o erro de fecho altimétrico teórico deveria ser:",
    "options": [
      "Sempre superior a 1 metro.",
      "Igual à soma de todas as distâncias percorridas.",
      "Zero, sendo o valor obtido na prática a medida do erro acumulado a distribuir.",
      "Impossível de calcular sem GPS."
    ],
    "answer": 2
  },
  {
    "id": 81,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.254 m e o fio superior marca 1.749 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "50.50 m",
      "24.75 m",
      "99.00 m",
      "49.50 m"
    ],
    "answer": 3
  },
  {
    "id": 82,
    "section": 1,
    "text": "A triangulação, como método clássico de apoio geodésico, baseia-se principalmente em:",
    "options": [
      "Nivelar directamente todos os vértices de uma rede.",
      "Utilizar apenas GPS, dispensando qualquer medição angular.",
      "Medir os ângulos dos triângulos de uma rede, com pelo menos uma base (distância) conhecida, para calcular as restantes distâncias e coordenadas por trigonometria.",
      "Medir apenas distâncias entre vértices de uma rede de triângulos, sem medir ângulos."
    ],
    "answer": 2
  },
  {
    "id": 83,
    "section": 1,
    "text": "Uma poligonal fechada tem 4 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "360°",
      "540°",
      "720°",
      "180°"
    ],
    "answer": 0
  },
  {
    "id": 84,
    "section": 1,
    "text": "Uma poligonal fechada tem 12 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1800°",
      "900°",
      "2160°",
      "1980°"
    ],
    "answer": 0
  },
  {
    "id": 85,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.765 m e o fio superior marca 2.262 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "99.40 m",
      "49.70 m",
      "50.70 m",
      "24.85 m"
    ],
    "answer": 1
  },
  {
    "id": 86,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 14°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NE 24°",
      "Rumo NE 76°, independentemente das condições do levantamento.",
      "Rumo SW 14°",
      "Rumo NE 14°"
    ],
    "answer": 3
  },
  {
    "id": 87,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.301 m e o fio superior marca 1.407 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "11.60 m",
      "5.30 m",
      "21.20 m",
      "10.60 m"
    ],
    "answer": 3
  },
  {
    "id": 88,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.432 m e o fio superior marca 1.876 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "45.40 m",
      "22.20 m",
      "44.40 m",
      "88.80 m"
    ],
    "answer": 2
  },
  {
    "id": 89,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.367 m e o fio superior marca 1.535 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "33.60 m",
      "16.80 m",
      "8.40 m",
      "17.80 m"
    ],
    "answer": 1
  },
  {
    "id": 90,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.378 m e o fio superior marca 1.696 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "32.80 m",
      "15.90 m",
      "31.80 m",
      "63.60 m"
    ],
    "answer": 2
  },
  {
    "id": 91,
    "section": 1,
    "text": "O termo \"cota\" ou \"altitude\", em topografia, refere-se a:",
    "options": [
      "A distância horizontal entre dois pontos, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector.",
      "O número de vértices de uma poligonal.",
      "A diferença angular entre duas direcções.",
      "A distância vertical de um ponto em relação a uma superfície de referência (geralmente o nível médio do mar)."
    ],
    "answer": 3
  },
  {
    "id": 92,
    "section": 1,
    "text": "Uma poligonal aberta, sem qualquer ponto de controlo final de coordenadas conhecidas, tem como principal desvantagem:",
    "options": [
      "Exigir sempre o uso de GPS RTK.",
      "Não permitir a verificação e distribuição do erro de fecho, pelo que os seus resultados devem ser interpretados com cautela.",
      "Ser sempre mais rápida de calcular do que uma poligonal fechada, independentemente do tipo e da marca de equipamento efectivamente utilizado.",
      "Não poder ser usada em levantamentos cadastrais."
    ],
    "answer": 1
  },
  {
    "id": 93,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 305°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 35°, independentemente da escala do levantamento.",
      "Rumo NW 65°",
      "Rumo NW 55°",
      "Rumo SE 55°"
    ],
    "answer": 2
  },
  {
    "id": 94,
    "section": 1,
    "text": "Ao migrar coordenadas de um sistema local para um sistema geodésico oficial (como o UTM), é fundamental:",
    "options": [
      "Ignorar qualquer diferença de Datum entre os dois sistemas, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina.",
      "Conhecer com precisão os parâmetros de transformação (Datum, projecção, ponto de amarração) entre os dois sistemas.",
      "Substituir as coordenadas Y pelas coordenadas X, sem mais nenhuma alteração.",
      "Multiplicar todas as coordenadas por dois."
    ],
    "answer": 1
  },
  {
    "id": 95,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 155°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 25°, conforme o entendimento tradicional sobre a matéria.",
      "Rumo SE 25°",
      "Rumo SE 35°",
      "Rumo SE 65°"
    ],
    "answer": 1
  },
  {
    "id": 96,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 72°27'36\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "72.4500°",
      "72.6000°",
      "73.4600°",
      "72.4600°"
    ],
    "answer": 3
  },
  {
    "id": 97,
    "section": 1,
    "text": "Uma poligonal enquadrada (ou apoiada) distingue-se de uma poligonal fechada porque:",
    "options": [
      "É sempre mais imprecisa do que uma poligonal fechada.",
      "Inicia e termina em dois pontos distintos de coordenadas conhecidas, permitindo igualmente o controlo do erro de fecho.",
      "Não permite qualquer controlo de erro, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Não necessita de qualquer medição de ângulos."
    ],
    "answer": 1
  },
  {
    "id": 98,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 27°07'09\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "28.1192°",
      "27.1500°",
      "27.1192°",
      "27.1167°"
    ],
    "answer": 2
  },
  {
    "id": 99,
    "section": 1,
    "text": "O Azimute de uma direcção é definido como o ângulo:",
    "options": [
      "Vertical, medido a partir do zénite.",
      "Medido a partir do Sul, no sentido anti-horário, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, independentemente da experiência do operador.",
      "Horizontal, medido a partir do Norte (verdadeiro, magnético ou de quadrícula), no sentido horário, até à direcção considerada, variando entre 0° e 360°.",
      "Formado exclusivamente entre duas visadas consecutivas de uma poligonal."
    ],
    "answer": 2
  },
  {
    "id": 100,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 350°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SE 10°",
      "Rumo NW 10°",
      "Rumo NW 20°, independentemente do equipamento utilizado.",
      "Rumo NW 80°"
    ],
    "answer": 1
  },
  {
    "id": 101,
    "section": 1,
    "text": "Uma poligonal fechada tem 10 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1800°",
      "720°",
      "1440°",
      "1620°"
    ],
    "answer": 2
  },
  {
    "id": 102,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 278°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 8°, sem necessidade de verificação adicional.",
      "Rumo NW 89°",
      "Rumo NW 82°",
      "Rumo SE 82°"
    ],
    "answer": 2
  },
  {
    "id": 103,
    "section": 1,
    "text": "Uma poligonal fechada tem 11 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "810°",
      "1620°",
      "1800°",
      "1980°"
    ],
    "answer": 1
  },
  {
    "id": 104,
    "section": 1,
    "text": "Uma poligonal fechada tem 10 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "720°",
      "1620°",
      "1800°",
      "1440°"
    ],
    "answer": 3
  },
  {
    "id": 105,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 166°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SE 24°",
      "Rumo SE 14°",
      "Rumo SE 76°",
      "Rumo NW 14°"
    ],
    "answer": 1
  },
  {
    "id": 106,
    "section": 1,
    "text": "Comparado com a estação total electrónica moderna, o método taqueométrico clássico com mira apresenta como principal limitação:",
    "options": [
      "Ser mais rápido e mais preciso do que qualquer estação total.",
      "Não poder ser utilizado em terrenos com vegetação, sem que seja necessária qualquer verificação ou confirmação adicional posterior, sendo esta a prática mais comum em campo.",
      "Necessitar sempre de correcção por GPS.",
      "Depender fortemente da leitura visual dos fios estadimétricos, o que introduz maior margem de erro humano e menor precisão em distâncias longas."
    ],
    "answer": 3
  },
  {
    "id": 107,
    "section": 1,
    "text": "Uma poligonal fechada tem 11 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1620°",
      "1800°",
      "1980°",
      "810°"
    ],
    "answer": 0
  },
  {
    "id": 108,
    "section": 1,
    "text": "A Altimetria (ou Hipsometria) tem como objectivo principal:",
    "options": [
      "Calcular apenas distâncias horizontais.",
      "Determinar a posição planimétrica dos pontos, sendo esta a prática mais comum em campo.",
      "Determinar as altitudes ou cotas dos pontos do terreno, representando o relevo.",
      "Definir os limites administrativos de um município."
    ],
    "answer": 2
  },
  {
    "id": 109,
    "section": 1,
    "text": "Uma poligonal fechada tem 12 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1980°",
      "1800°",
      "900°",
      "2160°"
    ],
    "answer": 1
  },
  {
    "id": 110,
    "section": 1,
    "text": "Os erros acidentais (ou aleatórios) em topografia caracterizam-se por:",
    "options": [
      "Resultarem de causas múltiplas e imprevisíveis, tendendo a compensar-se estatisticamente com o aumento do número de observações.",
      "Poderem ser completamente eliminados através de uma única medição cuidadosa.",
      "Não afectarem, de todo, a precisão de um levantamento.",
      "Serem sempre no mesmo sentido e de igual magnitude, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo."
    ],
    "answer": 0
  },
  {
    "id": 111,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.371 m e o fio superior marca 1.437 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "6.60 m",
      "3.30 m",
      "7.60 m",
      "13.20 m"
    ],
    "answer": 0
  },
  {
    "id": 112,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 100°53'39\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "100.8942°",
      "100.6500°",
      "101.8942°",
      "100.8833°"
    ],
    "answer": 0
  },
  {
    "id": 113,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 113°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 67°",
      "Rumo SE 23°",
      "Rumo SE 77°",
      "Rumo SE 67°"
    ],
    "answer": 3
  },
  {
    "id": 114,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 138°38'47\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "138.6333°",
      "139.6464°",
      "138.6464°",
      "138.7833°"
    ],
    "answer": 2
  },
  {
    "id": 115,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.101 m e o fio superior marca 1.349 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "25.80 m",
      "49.60 m",
      "12.40 m",
      "24.80 m"
    ],
    "answer": 3
  },
  {
    "id": 116,
    "section": 1,
    "text": "A Planimetria, enquanto ramo da Topografia, ocupa-se de:",
    "options": [
      "Exclusivamente do cálculo de volumes de terraplenagem.",
      "Da representação da posição dos pontos no plano horizontal, sem considerar o relevo.",
      "Da cartografia temática ambiental.",
      "Apenas da determinação de altitudes."
    ],
    "answer": 1
  },
  {
    "id": 117,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 176°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo SE 14°",
      "Rumo SE 86°",
      "Rumo SE 4°",
      "Rumo NW 4°"
    ],
    "answer": 2
  },
  {
    "id": 118,
    "section": 1,
    "text": "Uma poligonal fechada tem 8 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1440°",
      "540°",
      "1080°",
      "1260°"
    ],
    "answer": 2
  },
  {
    "id": 119,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 318°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NW 42°",
      "Rumo NW 48°",
      "Rumo SE 42°",
      "Rumo NW 52°"
    ],
    "answer": 0
  },
  {
    "id": 120,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 217°01'48\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "217.0300°",
      "217.8000°",
      "217.0167°",
      "218.0300°"
    ],
    "answer": 0
  },
  {
    "id": 121,
    "section": 1,
    "text": "Na leitura de uma mira com estádia, o fio estadimétrico inferior marca 1.453 m e o fio superior marca 1.926 m. Considerando a constante estadimétrica K = 100, qual é a distância horizontal aproximada?",
    "options": [
      "48.30 m",
      "47.30 m",
      "94.60 m",
      "23.65 m"
    ],
    "answer": 1
  },
  {
    "id": 122,
    "section": 1,
    "text": "Uma poligonal fechada tem 10 vértices. Qual deve ser a soma teórica dos seus ângulos internos?",
    "options": [
      "1800°",
      "720°",
      "1620°",
      "1440°"
    ],
    "answer": 3
  },
  {
    "id": 123,
    "section": 1,
    "text": "Um alinhamento topográfico tem um Azimute de 222°. Qual é o Rumo (bearing) correspondente a esta direcção?",
    "options": [
      "Rumo NE 42°",
      "Rumo SW 42°",
      "Rumo SW 52°",
      "Rumo SW 48°, conforme o entendimento tradicional sobre a matéria."
    ],
    "answer": 1
  },
  {
    "id": 124,
    "section": 1,
    "text": "Uma poligonal, em topografia, é definida como:",
    "options": [
      "Um instrumento óptico usado para medir ângulos verticais, sendo este o procedimento historicamente seguido pela generalidade da profissão.",
      "Um tipo de mapa temático sem escala definida.",
      "Um conjunto de pontos ligados por alinhamentos rectos, cujos ângulos e distâncias são medidos para determinar as suas coordenadas.",
      "Um único ponto de coordenadas fixas."
    ],
    "answer": 2
  },
  {
    "id": 125,
    "section": 1,
    "text": "Um ângulo foi lido no instrumento como 176°57'31\". Qual é o valor equivalente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "176.9586°",
      "176.5167°",
      "177.9586°",
      "176.9500°"
    ],
    "answer": 0
  },
  {
    "id": 126,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 213°15'38\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "213.1500°",
      "213.6333°",
      "213.2606°",
      "212.2606°"
    ],
    "answer": 2
  },
  {
    "id": 127,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 88.571 m até um prisma cuja constante é +0.000 m. Qual é a distância corrigida a considerar?",
    "options": [
      "88.571 m",
      "88.571 m",
      "88.581 m",
      "88.571 m"
    ],
    "answer": 0
  },
  {
    "id": 128,
    "section": 2,
    "text": "A introdução da constante do prisma no software da Estação Total é necessária porque:",
    "options": [
      "Todos os prismas têm exactamente a mesma constante, tornando este passo dispensável.",
      "Diferentes modelos de prisma têm um desvio (offset) próprio entre o seu centro óptico e o ponto de reflexão efectivo, que deve ser compensado na distância medida.",
      "Serve exclusivamente para ajustar o brilho do sinal laser.",
      "Esta constante serve apenas para calibrar o GPS integrado."
    ],
    "answer": 1
  },
  {
    "id": 129,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 293°42'09\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "292.7025°",
      "293.7025°",
      "293.4200°",
      "293.1500°"
    ],
    "answer": 1
  },
  {
    "id": 130,
    "section": 2,
    "text": "O transporte inadequado de uma Estação Total (por exemplo, sem a devida protecção contra choques) pode provocar:",
    "options": [
      "Apenas um efeito estético, sem qualquer impacto técnico.",
      "Uma melhoria automática da precisão do equipamento.",
      "Nenhum efeito relevante na precisão do instrumento.",
      "Desajustes nos eixos e componentes internos do instrumento, introduzindo ou agravando erros sistemáticos nas medições."
    ],
    "answer": 3
  },
  {
    "id": 131,
    "section": 2,
    "text": "Sem reflector (modo \"reflectorless\"), muitas Estações Totais modernas conseguem medir distâncias porque:",
    "options": [
      "O feixe laser é reflectido directamente pela própria superfície do objecto observado, dispensando o uso de prisma, embora com alcance geralmente menor.",
      "Utilizam exclusivamente sinais de rádio de longo alcance.",
      "Calculam a distância apenas a partir do ângulo vertical, sem qualquer medição electrónica.",
      "Estimam a distância apenas por triangulação com satélites GPS."
    ],
    "answer": 0
  },
  {
    "id": 132,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 360337 m, Norte = 8109222 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = +35 m e ΔNorte = -10 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 360302 m, Norte = 8109232 m",
      "Este = 360372 m, Norte = 8109212 m",
      "Este = 360337 m, Norte = 8109222 m",
      "Este = 360372 m, Norte = 8109232 m, sendo esta a prática mais comum em campo."
    ],
    "answer": 1
  },
  {
    "id": 133,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 348°51'08\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "348.1333°",
      "348.5100°",
      "347.8522°",
      "348.8522°"
    ],
    "answer": 3
  },
  {
    "id": 134,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 543491 m, Norte = 8031913 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = -97 m e ΔNorte = -33 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 543588 m, Norte = 8031946 m",
      "Este = 543491 m, Norte = 8031913 m",
      "Este = 543394 m, Norte = 8031946 m, independentemente da experiência do operador.",
      "Este = 543394 m, Norte = 8031880 m"
    ],
    "answer": 3
  },
  {
    "id": 135,
    "section": 2,
    "text": "O distanciómetro electrónico (EDM), integrado na Estação Total, mede distâncias através de:",
    "options": [
      "Emissão de um sinal (geralmente infravermelho ou laser) que é reflectido por um prisma (ou pela própria superfície) e cujo tempo ou fase de retorno permite calcular a distância.",
      "Comparação directa com uma fita métrica de referência.",
      "Cálculo baseado apenas em coordenadas GPS previamente introduzidas.",
      "Observação exclusivamente visual através da luneta."
    ],
    "answer": 0
  },
  {
    "id": 136,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 69°05'55\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "69.0986°",
      "68.0986°",
      "69.9167°",
      "69.0500°"
    ],
    "answer": 0
  },
  {
    "id": 137,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 254 m e o ângulo vertical observado é de -12°. A altura do instrumento (hi) é 1.45 m e a altura do alvo/prisma (ht) é 1.86 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-12°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-53.99 m",
      "-53.58 m",
      "-54.40 m",
      "54.40 m"
    ],
    "answer": 2
  },
  {
    "id": 138,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 157.484 m até um prisma cuja constante é +0.000 m. Qual é a distância corrigida a considerar?",
    "options": [
      "157.494 m",
      "157.484 m",
      "157.484 m",
      "157.484 m"
    ],
    "answer": 2
  },
  {
    "id": 139,
    "section": 2,
    "text": "A calagem (nivelamento) de um instrumento sobre o tripé, através dos parafusos niveladores e da bolha esférica/tubular, tem como objectivo:",
    "options": [
      "Colocar o eixo principal (vertical) do instrumento efectivamente na vertical do local.",
      "Substituir a necessidade de centragem sobre o ponto.",
      "Ajustar automaticamente a hora do equipamento, independentemente do tipo e da marca de equipamento efectivamente utilizado.",
      "Aumentar o alcance do distanciómetro."
    ],
    "answer": 0
  },
  {
    "id": 140,
    "section": 2,
    "text": "A escolha entre mira de madeira, alumínio ou fibra de vidro (fibra de invar em trabalhos de alta precisão) relaciona-se sobretudo com:",
    "options": [
      "A marca do fabricante da Estação Total utilizada em conjunto.",
      "O preço, sendo este o único critério relevante.",
      "O peso, a durabilidade e a estabilidade dimensional face a variações de temperatura, sendo a invar reservada a trabalhos de nivelamento de alta precisão.",
      "A cor do instrumento, sem qualquer efeito técnico, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, independentemente das condições do levantamento."
    ],
    "answer": 2
  },
  {
    "id": 141,
    "section": 2,
    "text": "O posicionamento GPS estático (com pós-processamento) é geralmente preferido em relação ao RTK quando se pretende:",
    "options": [
      "Evitar por completo a utilização de qualquer satélite.",
      "Obter resultados imediatos no terreno, sem qualquer processamento posterior.",
      "Alcançar maior precisão em linhas de base mais longas, através da observação prolongada e do pós-processamento dos dados brutos.",
      "Trabalhar exclusivamente em áreas urbanas densamente construídas."
    ],
    "answer": 2
  },
  {
    "id": 142,
    "section": 2,
    "text": "O tribrach (base niveladora) de um instrumento topográfico tem como função:",
    "options": [
      "Permitir a fixação, centragem e nivelamento do instrumento (ou prisma) sobre o tripé, através dos parafusos de calagem.",
      "Armazenar os dados registados no levantamento.",
      "Substituir a função do distanciómetro electrónico.",
      "Medir directamente ângulos verticais, sendo este o procedimento historicamente seguido pela generalidade da profissão, sem necessidade de verificação adicional."
    ],
    "answer": 0
  },
  {
    "id": 143,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 599051 m, Norte = 8772776 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = -7 m e ΔNorte = +34 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 599044 m, Norte = 8772810 m",
      "Este = 599044 m, Norte = 8772742 m",
      "Este = 599051 m, Norte = 8772776 m",
      "Este = 599058 m, Norte = 8772742 m"
    ],
    "answer": 0
  },
  {
    "id": 144,
    "section": 2,
    "text": "A função de \"estação livre\" (resseção), disponível em muitas Estações Totais modernas, permite:",
    "options": [
      "Substituir a função do distanciómetro electrónico.",
      "Ser usada apenas em levantamentos batimétricos, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo, independentemente da experiência do operador.",
      "Determinar as coordenadas do próprio ponto de estação a partir da observação de pontos de coordenadas conhecidas, sem necessidade de estacionar sobre um ponto pré-definido.",
      "Eliminar totalmente a necessidade de qualquer ponto de coordenadas conhecidas na área."
    ],
    "answer": 2
  },
  {
    "id": 145,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 212 m e o ângulo vertical observado é de 3°. A altura do instrumento (hi) é 1.43 m e a altura do alvo/prisma (ht) é 1.41 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(3°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "11.13 m",
      "11.09 m",
      "11.11 m",
      "-11.13 m"
    ],
    "answer": 0
  },
  {
    "id": 146,
    "section": 2,
    "text": "As condições atmosféricas (temperatura e pressão) podem afectar a medição de distâncias por EDM porque:",
    "options": [
      "Alteram a velocidade de propagação da onda electromagnética no ar, exigindo correcções atmosféricas para distâncias de maior precisão.",
      "Só são relevantes durante a noite, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector, conforme adoptado na maioria dos projectos.",
      "Não têm qualquer efeito relevante em distâncias medidas por EDM.",
      "Afectam apenas a medição de ângulos, nunca de distâncias."
    ],
    "answer": 0
  },
  {
    "id": 147,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 211.521 m até um prisma cuja constante é +0.000 m. Qual é a distância corrigida a considerar?",
    "options": [
      "211.521 m",
      "211.521 m",
      "211.521 m",
      "211.531 m"
    ],
    "answer": 1
  },
  {
    "id": 148,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 80 m e o ângulo vertical observado é de 5°. A altura do instrumento (hi) é 1.65 m e a altura do alvo/prisma (ht) é 1.58 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(5°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "7.00 m",
      "-7.07 m",
      "7.07 m",
      "6.93 m"
    ],
    "answer": 2
  },
  {
    "id": 149,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 89.761 m até um prisma cuja constante é +0.000 m. Qual é a distância corrigida a considerar?",
    "options": [
      "89.771 m",
      "89.761 m",
      "89.761 m",
      "89.761 m"
    ],
    "answer": 3
  },
  {
    "id": 150,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 343520 m, Norte = 8919654 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = +3 m e ΔNorte = +46 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 343520 m, Norte = 8919654 m",
      "Este = 343523 m, Norte = 8919608 m, conforme os manuais técnicos da área.",
      "Este = 343517 m, Norte = 8919608 m",
      "Este = 343523 m, Norte = 8919700 m"
    ],
    "answer": 3
  },
  {
    "id": 151,
    "section": 2,
    "text": "O tripé, enquanto suporte dos instrumentos topográficos, deve ser montado de forma a garantir:",
    "options": [
      "Estabilidade e firmeza no terreno, com as pernas bem fixas e um posicionamento aproximadamente centrado sobre o ponto de estação.",
      "Máxima altura possível, independentemente da estabilidade.",
      "Ser montado apenas em superfícies de betão.",
      "Estar sempre orientado exactamente para Norte."
    ],
    "answer": 0
  },
  {
    "id": 152,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 321.910 m até um prisma cuja constante é +0.010 m. Qual é a distância corrigida a considerar?",
    "options": [
      "321.920 m",
      "321.930 m",
      "321.910 m",
      "321.900 m"
    ],
    "answer": 0
  },
  {
    "id": 153,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 145 m e o ângulo vertical observado é de 14°. A altura do instrumento (hi) é 1.54 m e a altura do alvo/prisma (ht) é 1.88 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(14°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "36.15 m",
      "-35.81 m",
      "36.49 m",
      "35.81 m"
    ],
    "answer": 3
  },
  {
    "id": 154,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 236°01'34\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "236.0261°",
      "236.0100°",
      "236.5667°",
      "235.0261°"
    ],
    "answer": 0
  },
  {
    "id": 155,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 191°37'56\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "191.9333°",
      "190.6322°",
      "191.6322°",
      "191.3700°"
    ],
    "answer": 2
  },
  {
    "id": 156,
    "section": 2,
    "text": "A mira telescópica (retráctil), muito usada em campo pela sua portabilidade, deve ser utilizada com atenção especial a:",
    "options": [
      "Nunca precisar de qualquer verificação antes da leitura.",
      "Ser sempre usada dobrada, para maior estabilidade.",
      "Verificar se está totalmente estendida e correctamente travada, para evitar leituras erradas por colapso parcial dos troços.",
      "Substituir totalmente a necessidade do nível óptico, independentemente das condições específicas do levantamento e do tipo de terreno envolvido."
    ],
    "answer": 2
  },
  {
    "id": 157,
    "section": 2,
    "text": "Em terreno instável ou com vento forte, a estabilidade do tripé pode ser reforçada, entre outras formas, através de:",
    "options": [
      "Aumentar ao máximo a altura do tripé, independentemente do terreno.",
      "Não calar o instrumento, para que se ajuste sozinho.",
      "Retirar uma das três pernas do tripé para reduzir o peso, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina.",
      "Cravar bem as pontas das pernas no solo e, se necessário, suspender um peso no gancho central do tripé."
    ],
    "answer": 3
  },
  {
    "id": 158,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 641644 m, Norte = 8251659 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = -16 m e ΔNorte = +25 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 641660 m, Norte = 8251634 m, conforme adoptado na maioria dos projectos.",
      "Este = 641628 m, Norte = 8251634 m",
      "Este = 641628 m, Norte = 8251684 m",
      "Este = 641644 m, Norte = 8251659 m"
    ],
    "answer": 2
  },
  {
    "id": 159,
    "section": 2,
    "text": "O eixo secundário (eixo dos munhões) de um teodolito ou Estação Total deve estar, idealmente:",
    "options": [
      "Inclinado 45° em relação ao eixo principal.",
      "Perfeitamente perpendicular ao eixo principal (vertical) do instrumento; um desvio nesta perpendicularidade constitui o erro de inclinação do eixo secundário.",
      "Sempre na horizontal, independentemente da calagem do instrumento, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo, independentemente da experiência do operador.",
      "Paralelo à linha de visada da luneta, sem qualquer relação com o eixo principal."
    ],
    "answer": 1
  },
  {
    "id": 160,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 65 m e o ângulo vertical observado é de -3°. A altura do instrumento (hi) é 1.55 m e a altura do alvo/prisma (ht) é 1.55 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-3°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-3.41 m",
      "3.41 m",
      "-3.41 m",
      "-3.41 m"
    ],
    "answer": 3
  },
  {
    "id": 161,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 372.618 m até um prisma cuja constante é -0.040 m. Qual é a distância corrigida a considerar?",
    "options": [
      "372.658 m",
      "372.588 m",
      "372.618 m",
      "372.578 m"
    ],
    "answer": 3
  },
  {
    "id": 162,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 25°48'59\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "25.9833°",
      "25.8164°",
      "25.4800°",
      "24.8164°"
    ],
    "answer": 1
  },
  {
    "id": 163,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 259 m e o ângulo vertical observado é de -11°. A altura do instrumento (hi) é 1.65 m e a altura do alvo/prisma (ht) é 1.97 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-11°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-50.66 m",
      "50.66 m",
      "-50.34 m",
      "-50.02 m"
    ],
    "answer": 0
  },
  {
    "id": 164,
    "section": 2,
    "text": "O limbo horizontal graduado de um teodolito serve para:",
    "options": [
      "Substituir a função da bolha esférica.",
      "Verificar apenas a horizontalidade da mira, conforme geralmente indicado nos manuais técnicos de referência da área.",
      "Permitir a leitura do ângulo horizontal correspondente à direcção observada.",
      "Medir directamente distâncias inclinadas."
    ],
    "answer": 2
  },
  {
    "id": 165,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 135.333 m até um prisma cuja constante é -0.040 m. Qual é a distância corrigida a considerar?",
    "options": [
      "135.333 m",
      "135.303 m",
      "135.293 m",
      "135.373 m"
    ],
    "answer": 2
  },
  {
    "id": 166,
    "section": 2,
    "text": "O nível laser rotativo, utilizado frequentemente em obras de construção civil, tem como principal aplicação:",
    "options": [
      "Medir ângulos horizontais com elevada precisão geodésica, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina, sem necessidade de verificação adicional.",
      "Projectar um plano horizontal (ou vertical) de referência visível ou detectável por um receptor, facilitando o controlo de nivelamento em obra.",
      "Realizar levantamentos batimétricos em grandes profundidades.",
      "Substituir por completo o GPS em qualquer levantamento."
    ],
    "answer": 1
  },
  {
    "id": 167,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 2.114 m e 1.540 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "57.40 m",
      "28.70 m",
      "86.10 m",
      "56.40 m"
    ],
    "answer": 0
  },
  {
    "id": 168,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 355.819 m até um prisma cuja constante é +0.010 m. Qual é a distância corrigida a considerar?",
    "options": [
      "355.809 m",
      "355.839 m",
      "355.829 m",
      "355.819 m"
    ],
    "answer": 2
  },
  {
    "id": 169,
    "section": 2,
    "text": "Um tripé com juntas ou parafusos de fixação das pernas desgastados pode provocar:",
    "options": [
      "Nenhum efeito relevante na qualidade do levantamento.",
      "Um aumento automático da precisão do EDM, sendo esta uma prática amplamente disseminada entre topógrafos com maior experiência.",
      "Pequenos movimentos ou vibrações durante a observação, comprometendo a precisão das leituras angulares e de distância.",
      "Uma melhoria da estabilidade do instrumento."
    ],
    "answer": 2
  },
  {
    "id": 170,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 506487 m, Norte = 9169197 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = +71 m e ΔNorte = +32 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 506416 m, Norte = 9169165 m",
      "Este = 506558 m, Norte = 9169165 m",
      "Este = 506558 m, Norte = 9169229 m",
      "Este = 506487 m, Norte = 9169197 m, independentemente da experiência do operador."
    ],
    "answer": 2
  },
  {
    "id": 171,
    "section": 2,
    "text": "Numa mira dupla-face (com graduação em ambos os lados, por vezes com origens diferentes), o objectivo é:",
    "options": [
      "Servir exclusivamente como suporte do prisma.",
      "Reduzir para metade o peso da mira, conforme geralmente indicado nos manuais técnicos de referência da área.",
      "Permitir uma verificação adicional da leitura, comparando os valores obtidos nas duas faces.",
      "Eliminar totalmente a necessidade de calagem do nível."
    ],
    "answer": 2
  },
  {
    "id": 172,
    "section": 2,
    "text": "O nível digital (electrónico), em comparação com o nível óptico, tem como principal vantagem:",
    "options": [
      "Ler automaticamente a mira codificada por processamento de imagem, reduzindo o erro de leitura humana e permitindo o registo automático dos dados.",
      "Não necessitar de mira para efectuar a leitura.",
      "Dispensar totalmente qualquer calibração, sendo esta uma prática amplamente disseminada entre topógrafos com maior experiência, conforme o entendimento tradicional sobre a matéria.",
      "Ser sempre mais barato do que qualquer nível óptico."
    ],
    "answer": 0
  },
  {
    "id": 173,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.915 m e 1.572 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "34.30 m",
      "17.15 m",
      "51.45 m",
      "33.30 m"
    ],
    "answer": 0
  },
  {
    "id": 174,
    "section": 2,
    "text": "O prisma de 360° (circular), muito utilizado em levantamentos com Estação Total robótica, tem como principal vantagem:",
    "options": [
      "Funcionar apenas com sinais GPS, sem qualquer EDM.",
      "Dispensar totalmente a necessidade de calibração de constante.",
      "Ser sempre mais preciso do que um prisma simples, independentemente da distância.",
      "Ser visível pela Estação Total a partir de qualquer direcção horizontal, sem necessidade de orientação manual do operador do prisma."
    ],
    "answer": 3
  },
  {
    "id": 175,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 343.374 m até um prisma cuja constante é +0.000 m. Qual é a distância corrigida a considerar?",
    "options": [
      "343.374 m",
      "343.384 m",
      "343.374 m",
      "343.374 m"
    ],
    "answer": 2
  },
  {
    "id": 176,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 345.169 m até um prisma cuja constante é -0.030 m. Qual é a distância corrigida a considerar?",
    "options": [
      "345.169 m",
      "345.199 m",
      "345.139 m",
      "345.149 m"
    ],
    "answer": 2
  },
  {
    "id": 177,
    "section": 2,
    "text": "Um estojo (case) de transporte adequado para os instrumentos topográficos tem, entre outras funções, a de:",
    "options": [
      "Substituir a necessidade de qualquer tripé, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, independentemente da escala do levantamento.",
      "Proteger o equipamento de choques, poeira e humidade durante o transporte e armazenamento, contribuindo para a preservação da sua calibração.",
      "Servir como fonte de alimentação eléctrica do instrumento.",
      "Aumentar artificialmente o alcance do distanciómetro."
    ],
    "answer": 1
  },
  {
    "id": 178,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 92 m e o ângulo vertical observado é de -13°. A altura do instrumento (hi) é 1.54 m e a altura do alvo/prisma (ht) é 1.71 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-13°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "21.41 m",
      "-21.24 m",
      "-21.07 m",
      "-21.41 m"
    ],
    "answer": 3
  },
  {
    "id": 179,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 66 m e o ângulo vertical observado é de -11°. A altura do instrumento (hi) é 1.69 m e a altura do alvo/prisma (ht) é 1.85 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-11°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-12.67 m",
      "-12.99 m",
      "12.99 m",
      "-12.83 m"
    ],
    "answer": 1
  },
  {
    "id": 180,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 271 m e o ângulo vertical observado é de 5°. A altura do instrumento (hi) é 1.62 m e a altura do alvo/prisma (ht) é 1.74 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(5°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-23.59 m",
      "23.83 m",
      "23.71 m",
      "23.59 m"
    ],
    "answer": 3
  },
  {
    "id": 181,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 130°35'50\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "129.5972°",
      "130.3500°",
      "130.5972°",
      "130.8333°"
    ],
    "answer": 2
  },
  {
    "id": 182,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 213 m e o ângulo vertical observado é de 5°. A altura do instrumento (hi) é 1.62 m e a altura do alvo/prisma (ht) é 1.90 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(5°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-18.36 m",
      "18.92 m",
      "18.36 m",
      "18.64 m"
    ],
    "answer": 2
  },
  {
    "id": 183,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 561742 m, Norte = 8299619 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = -27 m e ΔNorte = +85 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 561769 m, Norte = 8299534 m",
      "Este = 561715 m, Norte = 8299534 m",
      "Este = 561715 m, Norte = 8299704 m",
      "Este = 561742 m, Norte = 8299619 m, independentemente das condições do levantamento."
    ],
    "answer": 2
  },
  {
    "id": 184,
    "section": 2,
    "text": "O formato de exportação de dados de campo (por exemplo, ficheiros de texto delimitados por vírgula, com coordenadas Ponto/Este/Norte/Cota/Descrição) é importante porque:",
    "options": [
      "Não tem qualquer relevância prática no fluxo de trabalho.",
      "É obrigatório apenas em levantamentos batimétricos.",
      "Serve apenas para efeitos de arquivo histórico, sem uso prático, sendo este o procedimento historicamente seguido pela generalidade da profissão.",
      "Permite a compatibilidade e a importação directa dos dados observados em software de desenho (CAD) ou de processamento topográfico."
    ],
    "answer": 3
  },
  {
    "id": 185,
    "section": 2,
    "text": "A calibração periódica dos instrumentos topográficos (Estação Total, nível, GPS) é importante porque:",
    "options": [
      "Choques, variações de temperatura e o uso continuado podem desajustar os instrumentos, tornando necessária a verificação e correcção periódica dos seus erros sistemáticos.",
      "É uma exigência meramente burocrática, sem qualquer efeito técnico.",
      "Só é necessária uma vez, no momento da compra do equipamento.",
      "Os instrumentos, uma vez fabricados, nunca perdem a sua precisão original, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, conforme os manuais técnicos da área."
    ],
    "answer": 0
  },
  {
    "id": 186,
    "section": 2,
    "text": "O colector de dados (data collector), utilizado em conjunto com a Estação Total ou receptor GNSS, tem como função:",
    "options": [
      "Servir exclusivamente como fonte de alimentação eléctrica do instrumento.",
      "Medir directamente ângulos verticais sem qualquer instrumento óptico, independentemente do tipo e da marca de equipamento efectivamente utilizado, independentemente das condições do levantamento.",
      "Substituir totalmente a necessidade de qualquer instrumento de medição.",
      "Registar, armazenar e por vezes processar em campo os dados observados (ângulos, distâncias, coordenadas), facilitando a posterior transferência para o computador de escritório."
    ],
    "answer": 3
  },
  {
    "id": 187,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 401133 m, Norte = 8916146 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = +14 m e ΔNorte = -61 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 401147 m, Norte = 8916207 m",
      "Este = 401147 m, Norte = 8916085 m",
      "Este = 401133 m, Norte = 8916146 m",
      "Este = 401119 m, Norte = 8916207 m"
    ],
    "answer": 1
  },
  {
    "id": 188,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 186 m e o ângulo vertical observado é de 3°. A altura do instrumento (hi) é 1.63 m e a altura do alvo/prisma (ht) é 1.96 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(3°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "9.42 m",
      "9.75 m",
      "10.08 m",
      "-9.42 m"
    ],
    "answer": 0
  },
  {
    "id": 189,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 166 m e o ângulo vertical observado é de 5°. A altura do instrumento (hi) é 1.56 m e a altura do alvo/prisma (ht) é 1.67 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(5°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-14.41 m",
      "14.52 m",
      "14.41 m",
      "14.63 m"
    ],
    "answer": 2
  },
  {
    "id": 190,
    "section": 2,
    "text": "O erro de verticalidade do eixo principal de uma Estação Total, se não corrigido através da calagem cuidadosa do instrumento, afecta:",
    "options": [
      "Apenas o funcionamento do GPS integrado.",
      "Apenas a leitura de distâncias, nunca os ângulos.",
      "Nada, pois é sempre corrigido automaticamente pelo software, conforme geralmente indicado nos manuais técnicos de referência da área.",
      "Tanto as leituras angulares horizontais como verticais, e não é eliminado pela observação em dupla posição."
    ],
    "answer": 3
  },
  {
    "id": 191,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 213°55'19\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "213.3167°",
      "213.9219°",
      "212.9219°",
      "213.5500°"
    ],
    "answer": 1
  },
  {
    "id": 192,
    "section": 2,
    "text": "A Estação Total é um instrumento que combina, essencialmente:",
    "options": [
      "Um drone e uma câmara fotográfica, independentemente das condições específicas do levantamento e do tipo de terreno envolvido.",
      "Apenas um receptor GPS de dupla frequência.",
      "Um teodolito electrónico (para medição de ângulos) e um distanciómetro electrónico (EDM), integrados numa única unidade.",
      "Um nível óptico e uma bússola."
    ],
    "answer": 2
  },
  {
    "id": 193,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.610 m e 1.271 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "50.85 m",
      "16.95 m",
      "33.90 m",
      "32.90 m"
    ],
    "answer": 2
  },
  {
    "id": 194,
    "section": 2,
    "text": "A comunicação Bluetooth entre a Estação Total (ou receptor GNSS) e o colector de dados/controlador permite:",
    "options": [
      "Aumentar a precisão da medição angular do instrumento, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo.",
      "Eliminar a necessidade de qualquer calibração do EDM.",
      "Substituir totalmente a necessidade de baterias em qualquer dos equipamentos.",
      "Transferir dados sem fios entre os dois equipamentos, facilitando a operação e o registo em campo."
    ],
    "answer": 3
  },
  {
    "id": 195,
    "section": 2,
    "text": "A precisão nominal de um EDM é normalmente expressa numa forma do tipo \"± (2 mm + 2 ppm)\". O termo \"ppm\" (partes por milhão) significa que:",
    "options": [
      "O instrumento só funciona correctamente até 1 milhão de metros.",
      "Refere-se exclusivamente à precisão da bateria do equipamento.",
      "Uma parcela do erro cresce proporcionalmente com a distância medida (por exemplo, 2 mm por cada quilómetro medido).",
      "O erro é sempre fixo, independentemente da distância medida, independentemente das condições específicas do levantamento e do tipo de terreno envolvido."
    ],
    "answer": 2
  },
  {
    "id": 196,
    "section": 2,
    "text": "A bolha tubular (ou de nível) existente num nível óptico tem como função:",
    "options": [
      "Permitir verificar e ajustar a horizontalidade da linha de visada do instrumento.",
      "Medir directamente a distância entre dois pontos.",
      "Indicar a temperatura ambiente durante a observação, sendo este o procedimento historicamente seguido pela generalidade da profissão.",
      "Substituir a necessidade da mira graduada."
    ],
    "answer": 0
  },
  {
    "id": 197,
    "section": 2,
    "text": "A obstrução do sinal de satélites (por exemplo, junto a edifícios altos ou sob copas de árvores densas) afecta o posicionamento GNSS principalmente porque:",
    "options": [
      "Aumenta sempre a precisão do levantamento.",
      "Não tem qualquer efeito na precisão do posicionamento, sendo esta uma prática amplamente disseminada entre topógrafos com maior experiência, conforme o entendimento tradicional sobre a matéria.",
      "Reduz o número de satélites visíveis e pode causar multitrajecto (multipath), degradando a precisão ou impossibilitando a fixação da solução.",
      "Só afecta a bateria do receptor, nunca a posição calculada."
    ],
    "answer": 2
  },
  {
    "id": 198,
    "section": 2,
    "text": "A realização de cópias de segurança (backup) regulares dos dados recolhidos no colector de campo é uma boa prática porque:",
    "options": [
      "É uma exigência exclusiva de levantamentos batimétricos.",
      "Aumenta automaticamente a precisão das medições já efectuadas.",
      "Protege o trabalho realizado contra perdas por avaria, dano ou eliminação acidental do equipamento ou do ficheiro.",
      "Os dados de campo nunca podem ser perdidos, tornando este cuidado desnecessário."
    ],
    "answer": 2
  },
  {
    "id": 199,
    "section": 2,
    "text": "O nível automático (de compensador) distingue-se do nível óptico tradicional porque:",
    "options": [
      "Utiliza um compensador óptico-mecânico que estabelece automaticamente a horizontalidade da linha de visada após uma calagem aproximada, dispensando o ajuste fino manual da bolha tubular.",
      "É sempre menos preciso do que o nível óptico tradicional.",
      "Só pode ser utilizado em interiores, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, conforme o entendimento tradicional sobre a matéria.",
      "Não necessita de qualquer mira para efectuar leituras."
    ],
    "answer": 0
  },
  {
    "id": 200,
    "section": 2,
    "text": "A sigla GNSS refere-se, de forma genérica, a:",
    "options": [
      "Ao conjunto de todos os sistemas globais de navegação por satélite (GPS, GLONASS, Galileo, BeiDou, entre outros).",
      "Uma unidade de medida de ângulos.",
      "Exclusivamente ao sistema de posicionamento norte-americano GPS, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector.",
      "Um tipo específico de Estação Total."
    ],
    "answer": 0
  },
  {
    "id": 201,
    "section": 2,
    "text": "O produto típico obtido do processamento fotogramétrico de imagens de drone inclui:",
    "options": [
      "Ortofotomapa, modelo digital de superfície (MDS/DSM) e, frequentemente, nuvem de pontos densa da área levantada.",
      "Exclusivamente coordenadas de um único ponto.",
      "Apenas um relatório de texto, sem qualquer imagem ou modelo.",
      "Um vídeo sem qualquer informação georreferenciada."
    ],
    "answer": 0
  },
  {
    "id": 202,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 377.641 m até um prisma cuja constante é -0.040 m. Qual é a distância corrigida a considerar?",
    "options": [
      "377.641 m",
      "377.601 m",
      "377.681 m",
      "377.611 m"
    ],
    "answer": 1
  },
  {
    "id": 203,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 51°13'06\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "51.1000°",
      "51.1300°",
      "50.2183°",
      "51.2183°"
    ],
    "answer": 3
  },
  {
    "id": 204,
    "section": 2,
    "text": "Antes de iniciar um levantamento importante, é boa prática verificar previamente:",
    "options": [
      "Apenas a cor da caixa de transporte do instrumento.",
      "A calagem e os principais erros instrumentais do equipamento, através de rotinas de verificação, para garantir a fiabilidade dos dados a recolher.",
      "Apenas se o instrumento tem bateria suficiente, sem qualquer outra verificação.",
      "Nada, pois todos os instrumentos saem sempre calibrados de fábrica para sempre, sendo esta uma prática amplamente disseminada entre topógrafos com maior experiência."
    ],
    "answer": 1
  },
  {
    "id": 205,
    "section": 2,
    "text": "O teodolito electrónico distingue-se do teodolito óptico-mecânico clássico principalmente porque:",
    "options": [
      "É sempre menos preciso do que o teodolito óptico clássico.",
      "Não permite qualquer medição de ângulos verticais, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, independentemente das condições do levantamento.",
      "Dispensa totalmente qualquer calagem do instrumento.",
      "Apresenta as leituras angulares em display digital, obtidas por sensores electrónicos, em vez da leitura visual em limbos graduados através de microscópio óptico."
    ],
    "answer": 3
  },
  {
    "id": 206,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.692 m e 1.571 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "18.15 m",
      "11.10 m",
      "6.05 m",
      "12.10 m"
    ],
    "answer": 3
  },
  {
    "id": 207,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.302 m e 1.177 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "11.50 m",
      "12.50 m",
      "6.25 m",
      "18.75 m"
    ],
    "answer": 1
  },
  {
    "id": 208,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.628 m e 0.936 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "68.20 m",
      "69.20 m",
      "103.80 m",
      "34.60 m"
    ],
    "answer": 1
  },
  {
    "id": 209,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.168 m e 1.036 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "19.80 m",
      "6.60 m",
      "12.20 m",
      "13.20 m"
    ],
    "answer": 3
  },
  {
    "id": 210,
    "section": 2,
    "text": "O teodolito, enquanto instrumento clássico de topografia, tem como função principal:",
    "options": [
      "Medir ângulos horizontais e verticais com elevada precisão.",
      "Realizar nivelamento geométrico directo, sem qualquer leitura angular.",
      "Substituir totalmente a necessidade de qualquer mira.",
      "Medir exclusivamente distâncias, sem qualquer medição angular."
    ],
    "answer": 0
  },
  {
    "id": 211,
    "section": 2,
    "text": "A observação em dupla posição (face directa e face inversa) numa Estação Total serve, entre outros objectivos, para:",
    "options": [
      "Eliminar ou minimizar erros instrumentais sistemáticos, como o erro de colimação horizontal e o erro de índice vertical.",
      "Aumentar o alcance máximo do distanciómetro.",
      "Reduzir o tempo total de trabalho de campo, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo.",
      "Substituir totalmente a necessidade de calibração periódica."
    ],
    "answer": 0
  },
  {
    "id": 212,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.080 m e 0.885 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "9.75 m",
      "29.25 m",
      "19.50 m",
      "18.50 m"
    ],
    "answer": 2
  },
  {
    "id": 213,
    "section": 2,
    "text": "A verificação da verticalidade da mira, através da bolha esférica ali instalada, é importante porque:",
    "options": [
      "A mira nunca precisa de estar na vertical para leituras correctas.",
      "Só é relevante em levantamentos com GPS.",
      "Serve apenas para efeitos estéticos do equipamento.",
      "Uma mira inclinada durante a leitura introduz um erro sistemático na leitura efectuada."
    ],
    "answer": 3
  },
  {
    "id": 214,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 198°36'14\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "198.6039°",
      "198.2333°",
      "197.6039°",
      "198.3600°"
    ],
    "answer": 0
  },
  {
    "id": 215,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 381.870 m até um prisma cuja constante é -0.030 m. Qual é a distância corrigida a considerar?",
    "options": [
      "381.900 m",
      "381.840 m",
      "381.870 m",
      "381.850 m"
    ],
    "answer": 1
  },
  {
    "id": 216,
    "section": 2,
    "text": "Um erro de verticalidade do bastão do prisma (baliza mal nivelada) durante a observação provoca:",
    "options": [
      "Nenhum erro relevante nas coordenadas do ponto observado.",
      "Um erro apenas na cota, nunca nas coordenadas planimétricas.",
      "Um deslocamento da posição real do ponto, tanto maior quanto maior for a inclinação da baliza e a distância entre o prisma e o ponto no terreno.",
      "Um erro que só afecta levantamentos batimétricos, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, independentemente do equipamento utilizado."
    ],
    "answer": 2
  },
  {
    "id": 217,
    "section": 2,
    "text": "O erro de colimação horizontal de uma Estação Total corresponde a:",
    "options": [
      "Um erro impossível de corrigir ou minimizar.",
      "Um desalinhamento entre o eixo óptico da luneta e o eixo de rotação horizontal do instrumento, sendo eliminável pela média das leituras em face directa e face inversa.",
      "Um erro exclusivo do distanciómetro electrónico.",
      "Um erro que só afecta a bateria do equipamento, independentemente do tipo e da marca de equipamento efectivamente utilizado, independentemente das condições do levantamento."
    ],
    "answer": 1
  },
  {
    "id": 218,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 88 m e o ângulo vertical observado é de 10°. A altura do instrumento (hi) é 1.49 m e a altura do alvo/prisma (ht) é 1.98 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(10°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "15.03 m",
      "16.01 m",
      "15.52 m",
      "-15.03 m"
    ],
    "answer": 0
  },
  {
    "id": 219,
    "section": 2,
    "text": "O método DGPS (GPS Diferencial) baseia-se em:",
    "options": [
      "Ser aplicável apenas em levantamentos aéreos.",
      "Utilizar exclusivamente sinais de rádio FM, sem qualquer satélite, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, independentemente da escala do levantamento.",
      "Dispensar totalmente a necessidade de qualquer receptor GPS no terreno.",
      "Aplicar correcções calculadas a partir de uma estação de referência de coordenadas conhecidas, melhorando a precisão do posicionamento em relação ao GPS autónomo simples."
    ],
    "answer": 3
  },
  {
    "id": 220,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 47°31'59\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "47.5331°",
      "46.5331°",
      "47.3100°",
      "47.9833°"
    ],
    "answer": 0
  },
  {
    "id": 221,
    "section": 2,
    "text": "O plumo óptico (ou laser) de um instrumento topográfico serve para:",
    "options": [
      "Verificar a horizontalidade da mira.",
      "Substituir a bolha esférica do tribrach.",
      "Auxiliar na centragem precisa do instrumento sobre o ponto de estação materializado no terreno.",
      "Medir a distância inclinada entre dois pontos, conforme geralmente indicado nos manuais técnicos de referência da área."
    ],
    "answer": 2
  },
  {
    "id": 222,
    "section": 2,
    "text": "Uma rede de estações de referência GNSS permanentes (por exemplo, do tipo NTRIP), utilizada para correcções RTK em rede, tem como principal vantagem:",
    "options": [
      "Funcionar apenas em condições de tempo nublado.",
      "Eliminar totalmente a necessidade de qualquer satélite, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, independentemente das condições do levantamento.",
      "Substituir a função da Estação Total em qualquer situação.",
      "Dispensar o utilizador de instalar a sua própria estação base, recebendo correcções via internet/rede móvel a partir de estações fixas já instaladas."
    ],
    "answer": 3
  },
  {
    "id": 223,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 119 m e o ângulo vertical observado é de 1°. A altura do instrumento (hi) é 1.44 m e a altura do alvo/prisma (ht) é 1.44 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(1°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-2.08 m",
      "2.08 m",
      "2.08 m",
      "2.08 m"
    ],
    "answer": 2
  },
  {
    "id": 224,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 210 m e o ângulo vertical observado é de -4°. A altura do instrumento (hi) é 1.40 m e a altura do alvo/prisma (ht) é 1.82 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-4°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-14.26 m",
      "15.10 m",
      "-14.68 m",
      "-15.10 m"
    ],
    "answer": 3
  },
  {
    "id": 225,
    "section": 2,
    "text": "A mira (ou estádia) graduada, utilizada em nivelamento geométrico, é tipicamente graduada em:",
    "options": [
      "Graus e minutos, conforme geralmente indicado nos manuais técnicos de referência da área, independentemente da experiência do operador.",
      "Apenas em polegadas, nunca no sistema métrico.",
      "Metros, decímetros, centímetros e milímetros, permitindo a leitura directa de alturas na linha de visada horizontal do nível.",
      "Uma escala de cores sem valores numéricos."
    ],
    "answer": 2
  },
  {
    "id": 226,
    "section": 2,
    "text": "O uso de Veículos Aéreos Não Tripulados (drones/UAV) em levantamentos topográficos permite, tipicamente:",
    "options": [
      "Medir directamente ângulos com a mesma precisão de uma Estação Total, sem qualquer processamento posterior.",
      "Obter, por fotogrametria aérea, um conjunto denso de pontos (nuvem de pontos) e ortofotomapas de uma área, de forma relativamente rápida.",
      "Eliminar totalmente a necessidade de qualquer software de processamento de imagem, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina.",
      "Substituir totalmente a necessidade de qualquer ponto de controlo terrestre."
    ],
    "answer": 1
  },
  {
    "id": 227,
    "section": 2,
    "text": "A manutenção regular da bateria de uma Estação Total ou receptor GNSS (evitando descargas totais frequentes e extremos de temperatura) é recomendada para:",
    "options": [
      "Substituir a necessidade de qualquer calibração do EDM.",
      "Aumentar artificialmente a precisão angular do instrumento.",
      "Prolongar a vida útil da bateria e garantir a disponibilidade de energia durante o trabalho de campo.",
      "Não ter qualquer efeito prático relevante."
    ],
    "answer": 2
  },
  {
    "id": 228,
    "section": 2,
    "text": "A verificação periódica (colimação) de um nível óptico, através, por exemplo, do método das duas estacas, serve para:",
    "options": [
      "Substituir a necessidade de qualquer mira.",
      "Detectar e permitir a correcção do erro de horizontalidade da linha de visada (erro de colimação vertical do nível).",
      "Verificar exclusivamente a bateria do equipamento.",
      "Aumentar o alcance máximo de leitura da mira."
    ],
    "answer": 1
  },
  {
    "id": 229,
    "section": 2,
    "text": "Os pontos de controlo terrestre (Ground Control Points - GCP), usados em levantamentos com drone, servem para:",
    "options": [
      "Aumentar o tempo de voo do drone.",
      "Servir apenas como decoração da área levantada, independentemente das condições específicas do levantamento e do tipo de terreno envolvido.",
      "Georreferenciar com precisão o modelo fotogramétrico gerado, ligando-o a um sistema de coordenadas conhecido.",
      "Substituir totalmente a necessidade de qualquer câmara no drone."
    ],
    "answer": 2
  },
  {
    "id": 230,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 230.477 m até um prisma cuja constante é +0.010 m. Qual é a distância corrigida a considerar?",
    "options": [
      "230.467 m",
      "230.477 m",
      "230.497 m",
      "230.487 m"
    ],
    "answer": 3
  },
  {
    "id": 231,
    "section": 2,
    "text": "Num levantamento com Estação Total, a altura do prisma (baliza) deve ser registada porque:",
    "options": [
      "Só é relevante em levantamentos com GPS, nunca com Estação Total.",
      "É necessária para o correcto cálculo da cota (altitude) do ponto observado, em conjunto com a altura do instrumento.",
      "É irrelevante para o cálculo de coordenadas, apenas para o cálculo de distâncias, independentemente das condições específicas do levantamento e do tipo de terreno envolvido.",
      "Serve apenas para calcular o peso do equipamento transportado."
    ],
    "answer": 1
  },
  {
    "id": 232,
    "section": 2,
    "text": "O bastão de prisma (baliza) utilizado em conjunto com a Estação Total deve estar:",
    "options": [
      "Rigorosamente na vertical (verificado pela bolha esférica da baliza), para que a posição medida corresponda correctamente ao ponto no terreno.",
      "Sempre inclinado, para facilitar a visada do operador, conforme geralmente indicado nos manuais técnicos de referência da área, conforme os manuais técnicos da área.",
      "Deitado no chão, apontando na direcção da estação.",
      "A uma altura fixa de exactamente 2 metros, sem excepção."
    ],
    "answer": 0
  },
  {
    "id": 233,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 113 m e o ângulo vertical observado é de -13°. A altura do instrumento (hi) é 1.58 m e a altura do alvo/prisma (ht) é 1.52 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-13°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "26.03 m",
      "-26.15 m",
      "-26.09 m",
      "-26.03 m"
    ],
    "answer": 3
  },
  {
    "id": 234,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 155 m e o ângulo vertical observado é de -14°. A altura do instrumento (hi) é 1.61 m e a altura do alvo/prisma (ht) é 1.56 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-14°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "38.60 m",
      "-38.70 m",
      "-38.60 m",
      "-38.65 m"
    ],
    "answer": 2
  },
  {
    "id": 235,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 221 m e o ângulo vertical observado é de 4°. A altura do instrumento (hi) é 1.64 m e a altura do alvo/prisma (ht) é 2.00 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(4°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "15.09 m",
      "-15.09 m",
      "15.81 m",
      "15.45 m"
    ],
    "answer": 0
  },
  {
    "id": 236,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 113°37'19\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "113.6219°",
      "112.6219°",
      "113.3700°",
      "113.3167°"
    ],
    "answer": 0
  },
  {
    "id": 237,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 641551 m, Norte = 8232888 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = -109 m e ΔNorte = -58 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 641660 m, Norte = 8232946 m",
      "Este = 641442 m, Norte = 8232830 m",
      "Este = 641442 m, Norte = 8232946 m, sem necessidade de verificação adicional.",
      "Este = 641551 m, Norte = 8232888 m"
    ],
    "answer": 1
  },
  {
    "id": 238,
    "section": 2,
    "text": "Um receptor GNSS regista, no Datum local, as coordenadas Este = 394786 m, Norte = 9169240 m. Sabendo que o parâmetro de transformação para o Datum WGS84, nesta zona, é ΔEste = +39 m e ΔNorte = +2 m, quais são as coordenadas equivalentes em WGS84?",
    "options": [
      "Este = 394786 m, Norte = 9169240 m",
      "Este = 394747 m, Norte = 9169238 m",
      "Este = 394825 m, Norte = 9169238 m, sem necessidade de verificação adicional.",
      "Este = 394825 m, Norte = 9169242 m"
    ],
    "answer": 3
  },
  {
    "id": 239,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.392 m e 0.951 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "43.10 m",
      "22.05 m",
      "66.15 m",
      "44.10 m"
    ],
    "answer": 3
  },
  {
    "id": 240,
    "section": 2,
    "text": "A sobreposição (overlap) longitudinal e transversal entre fotografias aéreas consecutivas, num voo fotogramétrico com drone, é planeada para:",
    "options": [
      "Reduzir a qualidade do modelo final, sendo um efeito indesejado mas inevitável.",
      "Garantir que cada ponto do terreno seja fotografado a partir de múltiplos ângulos, permitindo a correcta reconstrução tridimensional por fotogrametria.",
      "Aumentar o consumo de bateria sem qualquer benefício técnico.",
      "Substituir totalmente a necessidade de pontos de controlo terrestre."
    ],
    "answer": 1
  },
  {
    "id": 241,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 136°29'57\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "136.4992°",
      "136.9500°",
      "136.2900°",
      "135.4992°"
    ],
    "answer": 0
  },
  {
    "id": 242,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 115 m e o ângulo vertical observado é de 10°. A altura do instrumento (hi) é 1.64 m e a altura do alvo/prisma (ht) é 1.74 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(10°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "20.18 m",
      "20.38 m",
      "20.28 m",
      "-20.18 m"
    ],
    "answer": 0
  },
  {
    "id": 243,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 261.537 m até um prisma cuja constante é -0.034 m. Qual é a distância corrigida a considerar?",
    "options": [
      "261.537 m",
      "261.571 m",
      "261.513 m",
      "261.503 m"
    ],
    "answer": 3
  },
  {
    "id": 244,
    "section": 2,
    "text": "O software de campo (aplicação de campo) instalado no colector de dados permite tipicamente:",
    "options": [
      "Funcionar apenas com receptores GNSS, nunca com Estação Total.",
      "Apenas visualizar a hora e a data, sem qualquer outra função, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Substituir totalmente a necessidade de qualquer pós-processamento em escritório.",
      "Configurar o levantamento, introduzir códigos de detalhe, calcular replanteios e visualizar em tempo real os pontos já observados."
    ],
    "answer": 3
  },
  {
    "id": 245,
    "section": 2,
    "text": "O display de uma Estação Total apresenta a leitura angular 107°09'40\". Qual é o valor correspondente em graus decimais (arredondado a 4 casas)?",
    "options": [
      "107.1611°",
      "107.0900°",
      "107.6667°",
      "106.1611°"
    ],
    "answer": 0
  },
  {
    "id": 246,
    "section": 2,
    "text": "Num nivelamento trigonométrico, a distância horizontal ao alvo é 250 m e o ângulo vertical observado é de -4°. A altura do instrumento (hi) é 1.59 m e a altura do alvo/prisma (ht) é 1.69 m. Qual é o desnível (ΔH) entre os dois pontos? (use tan(-4°); ΔH = D·tan(ângulo) + hi − ht)",
    "options": [
      "-17.58 m",
      "17.58 m",
      "-17.48 m",
      "-17.38 m"
    ],
    "answer": 0
  },
  {
    "id": 247,
    "section": 2,
    "text": "O posicionamento GPS RTK (Real Time Kinematic) distingue-se do posicionamento estático porque:",
    "options": [
      "Só pode ser utilizado durante a noite.",
      "É sempre menos preciso do que o posicionamento absoluto simples (navegação).",
      "Não necessita de qualquer sinal de satélite.",
      "Fornece correcções e uma posição com precisão centimétrica em tempo real, através de uma estação base ou de uma rede de correcção."
    ],
    "answer": 3
  },
  {
    "id": 248,
    "section": 2,
    "text": "Um operador de Estação Total, ao visar uma mira, regista os fios estadimétricos superior e inferior como 1.302 m e 1.217 m, respectivamente. Assumindo a constante estadimétrica K = 100, qual é a distância horizontal medida?",
    "options": [
      "4.25 m",
      "8.50 m",
      "7.50 m",
      "12.75 m"
    ],
    "answer": 1
  },
  {
    "id": 249,
    "section": 2,
    "text": "A leitura de um ângulo num teodolito óptico clássico, através do microscópio de leitura, exige do operador:",
    "options": [
      "O uso obrigatório de um colector de dados electrónico.",
      "A presença de sinal GPS no momento da leitura.",
      "Nenhuma formação específica, sendo um processo totalmente automático.",
      "Treino e cuidado na interpretação da escala graduada, sendo uma fonte potencial de erro humano de leitura."
    ],
    "answer": 3
  },
  {
    "id": 250,
    "section": 2,
    "text": "Uma Estação Total mede uma distância bruta de 210.462 m até um prisma cuja constante é -0.034 m. Qual é a distância corrigida a considerar?",
    "options": [
      "210.428 m",
      "210.438 m",
      "210.496 m",
      "210.462 m"
    ],
    "answer": 0
  },
  {
    "id": 251,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 839 m, Norte = 460 m, observou-se um ponto com Azimute 96° e distância 47 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 885.74 m, Norte = 455.09 m",
      "Este = 792.26 m, Norte = 464.91 m, conforme os manuais técnicos da área.",
      "Este = 834.09 m, Norte = 506.74 m",
      "Este = 839.00 m, Norte = 460.00 m"
    ],
    "answer": 0
  },
  {
    "id": 252,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 582 m, Norte = 612 m, observou-se um ponto com Azimute 68° e distância 199 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 397.49 m, Norte = 537.45 m, independentemente das condições do levantamento.",
      "Este = 766.51 m, Norte = 686.55 m",
      "Este = 582.00 m, Norte = 612.00 m",
      "Este = 656.55 m, Norte = 796.51 m"
    ],
    "answer": 1
  },
  {
    "id": 253,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 32 m² e 56 m², distando 29 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1276.0 m³",
      "44.0 m³",
      "2552.0 m³",
      "638.0 m³"
    ],
    "answer": 0
  },
  {
    "id": 254,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 743 m e um erro de fecho linear em Este de -0.76 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 161 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.165 m",
      "0.329 m",
      "-0.760 m",
      "-0.165 m"
    ],
    "answer": 0
  },
  {
    "id": 255,
    "section": 3,
    "text": "No cálculo de um levantamento cadastral, a discrepância entre a área calculada a partir de coordenadas e a área registada em documentos antigos de propriedade pode dever-se a:",
    "options": [
      "Diferenças de precisão entre os métodos e equipamentos utilizados em diferentes épocas, exigindo uma análise cuidadosa antes de se concluir pela existência de um erro.",
      "Um fenómeno que não tem qualquer relevância prática ou legal.",
      "Nunca poder ocorrer, pois as áreas de propriedade são sempre imutáveis.",
      "Exclusivamente a erros do topógrafo actual, nunca a limitações dos levantamentos ou registos antigos, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector."
    ],
    "answer": 0
  },
  {
    "id": 256,
    "section": 3,
    "text": "O volume de terraplenagem entre duas secções transversais de um projecto (por exemplo, de uma estrada), calculado pelo método das áreas médias, é dado, de forma aproximada, por:",
    "options": [
      "Um valor que não depende da distância entre as secções consideradas.",
      "A diferença entre as duas áreas das secções.",
      "O produto da distância entre as secções pela média aritmética das duas áreas.",
      "A soma simples das duas áreas das secções, sem considerar a distância entre elas."
    ],
    "answer": 2
  },
  {
    "id": 257,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 44 m² e 36 m², distando 13 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1040.0 m³",
      "40.0 m³",
      "260.0 m³",
      "520.0 m³"
    ],
    "answer": 3
  },
  {
    "id": 258,
    "section": 3,
    "text": "Numa poligonal fechada com 6 vértices, a soma dos ângulos internos medidos foi 719.8000°, sendo o valor teórico esperado 720°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-2.00' por vértice",
      "2.40' por vértice",
      "2.00' por vértice",
      "12.00' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 259,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 8 m² e 56 m², distando 40 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1280.0 m³",
      "640.0 m³",
      "2560.0 m³",
      "32.0 m³"
    ],
    "answer": 0
  },
  {
    "id": 260,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 1187 m e um erro de fecho linear em Este de -0.17 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 392 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "-0.056 m",
      "-0.170 m",
      "0.056 m",
      "0.112 m"
    ],
    "answer": 2
  },
  {
    "id": 261,
    "section": 3,
    "text": "Numa poligonal fechada com 5 vértices, a soma dos ângulos internos medidos foi 540.5000°, sendo o valor teórico esperado 540°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-7.50' por vértice",
      "-6.00' por vértice",
      "-30.00' por vértice",
      "6.00' por vértice"
    ],
    "answer": 1
  },
  {
    "id": 262,
    "section": 3,
    "text": "No nivelamento trigonométrico, o desnível calculado entre dois pontos depende, essencialmente, de:",
    "options": [
      "Exclusivamente da altitude do ponto de estação, sem qualquer medição adicional.",
      "Apenas da distância horizontal, sem qualquer relação com o ângulo vertical.",
      "Do número de vértices da poligonal em que os pontos se inserem, conforme geralmente indicado nos manuais técnicos de referência da área.",
      "Da distância (horizontal ou inclinada) e do ângulo vertical observado, ajustados pelas alturas do instrumento e do alvo/prisma."
    ],
    "answer": 3
  },
  {
    "id": 263,
    "section": 3,
    "text": "A precisão relativa de uma poligonal, muitas vezes expressa na forma 1/N (por exemplo, 1/5000), representa:",
    "options": [
      "A escala da carta a produzir a partir da poligonal.",
      "Um valor sem qualquer significado prático, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "A relação entre o erro de fecho linear e o perímetro total da poligonal, sendo um indicador da qualidade do levantamento.",
      "O número total de vértices da poligonal."
    ],
    "answer": 2
  },
  {
    "id": 264,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 955 m e um erro de fecho linear em Este de 0.53 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 208 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.530 m",
      "-0.231 m",
      "0.115 m",
      "-0.115 m"
    ],
    "answer": 3
  },
  {
    "id": 265,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(16, 36); P2(27, 71); P3(52, 87); P4(82, 103). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "1653.00 m²",
      "826.50 m²",
      "413.25 m²",
      "876.50 m²"
    ],
    "answer": 1
  },
  {
    "id": 266,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 59 m² e 57 m², distando 56 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1624.0 m³",
      "58.0 m³",
      "6496.0 m³",
      "3248.0 m³"
    ],
    "answer": 3
  },
  {
    "id": 267,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(24, 31); P2(40, 33); P3(70, 62); P4(110, 73). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "330.00 m²",
      "165.00 m²",
      "82.50 m²",
      "215.00 m²"
    ],
    "answer": 1
  },
  {
    "id": 268,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 49 m² e 8 m², distando 34 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "28.5 m³",
      "969.0 m³",
      "484.5 m³",
      "1938.0 m³"
    ],
    "answer": 1
  },
  {
    "id": 269,
    "section": 3,
    "text": "Numa poligonal fechada com 7 vértices, a soma dos ângulos internos medidos foi 900.4000°, sendo o valor teórico esperado 900°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-24.00' por vértice",
      "-3.43' por vértice",
      "3.43' por vértice",
      "-4.00' por vértice"
    ],
    "answer": 1
  },
  {
    "id": 270,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 1083 m e um erro de fecho linear em Este de 0.40 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 193 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.071 m",
      "-0.071 m",
      "-0.143 m",
      "0.400 m"
    ],
    "answer": 1
  },
  {
    "id": 271,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 58 m² e 55 m², distando 34 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1921.0 m³",
      "56.5 m³",
      "960.5 m³",
      "3842.0 m³"
    ],
    "answer": 0
  },
  {
    "id": 272,
    "section": 3,
    "text": "Numa poligonal fechada com n vértices, a soma teórica dos ângulos internos medidos deve ser igual a:",
    "options": [
      "Sempre 360°, independentemente do número de vértices.",
      "(n - 2) × 180°.",
      "Sempre 180°, independentemente do número de vértices.",
      "n × 90°."
    ],
    "answer": 1
  },
  {
    "id": 273,
    "section": 3,
    "text": "Numa poligonal fechada com 8 vértices, a soma dos ângulos internos medidos foi 1080.4000°, sendo o valor teórico esperado 1080°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-3.00' por vértice",
      "-3.43' por vértice",
      "-24.00' por vértice",
      "3.00' por vértice"
    ],
    "answer": 0
  },
  {
    "id": 274,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 18 m² e 23 m², distando 53 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1086.5 m³",
      "2173.0 m³",
      "20.5 m³",
      "543.3 m³"
    ],
    "answer": 0
  },
  {
    "id": 275,
    "section": 3,
    "text": "Numa poligonal fechada com 9 vértices, a soma dos ângulos internos medidos foi 1260.3000°, sendo o valor teórico esperado 1260°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-2.00' por vértice",
      "-18.00' por vértice",
      "2.00' por vértice",
      "-2.25' por vértice"
    ],
    "answer": 0
  },
  {
    "id": 276,
    "section": 3,
    "text": "Numa poligonal fechada com 5 vértices, a soma dos ângulos internos medidos foi 539.8000°, sendo o valor teórico esperado 540°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "2.40' por vértice",
      "-2.40' por vértice",
      "12.00' por vértice",
      "3.00' por vértice"
    ],
    "answer": 0
  },
  {
    "id": 277,
    "section": 3,
    "text": "Numa poligonal fechada com 6 vértices, a soma dos ângulos internos medidos foi 720.4000°, sendo o valor teórico esperado 720°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-4.80' por vértice",
      "-24.00' por vértice",
      "-4.00' por vértice",
      "4.00' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 278,
    "section": 3,
    "text": "O erro de fecho linear (planimétrico) de uma poligonal fechada corresponde a:",
    "options": [
      "Um valor exclusivamente relacionado com o nivelamento, sem qualquer relação planimétrica, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, independentemente da experiência do operador.",
      "A soma de todos os ângulos internos medidos.",
      "A distância entre a posição calculada do ponto final da poligonal e a posição teórica esperada (que deveria coincidir com o ponto de partida, ou com o ponto de chegada de coordenadas conhecidas).",
      "Sempre zero, independentemente da precisão das observações."
    ],
    "answer": 2
  },
  {
    "id": 279,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(33, 29); P2(10, 61); P3(41, 61); P4(61, 80). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "370.00 m²",
      "1480.00 m²",
      "790.00 m²",
      "740.00 m²"
    ],
    "answer": 3
  },
  {
    "id": 280,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 57 m² e 26 m², distando 18 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1494.0 m³",
      "41.5 m³",
      "373.5 m³",
      "747.0 m³"
    ],
    "answer": 3
  },
  {
    "id": 281,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 301 m, Norte = 244 m, observou-se um ponto com Azimute 191° e distância 58 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 301.00 m, Norte = 244.00 m",
      "Este = 289.93 m, Norte = 187.07 m",
      "Este = 312.07 m, Norte = 300.93 m",
      "Este = 244.07 m, Norte = 232.93 m"
    ],
    "answer": 1
  },
  {
    "id": 282,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 41 m² e 15 m², distando 44 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "616.0 m³",
      "28.0 m³",
      "2464.0 m³",
      "1232.0 m³"
    ],
    "answer": 3
  },
  {
    "id": 283,
    "section": 3,
    "text": "Numa poligonal fechada com 10 vértices, a soma dos ângulos internos medidos foi 1440.1000°, sendo o valor teórico esperado 1440°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-0.67' por vértice",
      "-6.00' por vértice",
      "-0.60' por vértice",
      "0.60' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 284,
    "section": 3,
    "text": "Numa poligonal fechada com 6 vértices, a soma dos ângulos internos medidos foi 720.3000°, sendo o valor teórico esperado 720°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-18.00' por vértice",
      "3.00' por vértice",
      "-3.00' por vértice",
      "-3.60' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 285,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(21, 35); P2(10, 36); P3(49, 56); P4(73, 52). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "875.00 m²",
      "487.50 m²",
      "218.75 m²",
      "437.50 m²"
    ],
    "answer": 3
  },
  {
    "id": 286,
    "section": 3,
    "text": "Num levantamento com redundância de observações (mais medições do que o estritamente necessário para determinar as incógnitas), a principal vantagem é:",
    "options": [
      "Substituir totalmente a necessidade de qualquer cálculo de fecho.",
      "Permitir detectar inconsistências (erros) e efectuar um ajustamento estatístico que melhora a fiabilidade das coordenadas finais.",
      "Ser sempre proibida pelas boas práticas topográficas.",
      "Aumentar desnecessariamente o tempo de trabalho de campo, sem qualquer benefício técnico."
    ],
    "answer": 1
  },
  {
    "id": 287,
    "section": 3,
    "text": "Numa poligonal fechada com 9 vértices, a soma dos ângulos internos medidos foi 1260.1000°, sendo o valor teórico esperado 1260°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-0.67' por vértice",
      "-0.75' por vértice",
      "-6.00' por vértice",
      "0.67' por vértice"
    ],
    "answer": 0
  },
  {
    "id": 288,
    "section": 3,
    "text": "Numa poligonal fechada com 8 vértices, a soma dos ângulos internos medidos foi 1079.7000°, sendo o valor teórico esperado 1080°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-2.25' por vértice",
      "18.00' por vértice",
      "2.25' por vértice",
      "2.57' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 289,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 363 m, Norte = 435 m, observou-se um ponto com Azimute 84° e distância 38 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 363.00 m, Norte = 435.00 m",
      "Este = 366.97 m, Norte = 472.79 m, sendo esta a prática mais comum em campo.",
      "Este = 325.21 m, Norte = 431.03 m",
      "Este = 400.79 m, Norte = 438.97 m"
    ],
    "answer": 3
  },
  {
    "id": 290,
    "section": 3,
    "text": "A propagação de erros em cálculos topográficos (por exemplo, ao somar distâncias ou ângulos com erros associados) implica que:",
    "options": [
      "O erro combinado de grandezas independentes tende a ser calculado através da raiz quadrada da soma dos quadrados dos erros individuais (lei de propagação de erros), sendo geralmente inferior à soma directa.",
      "O erro final é sempre igual à soma directa dos erros individuais.",
      "Os erros individuais anulam-se sempre completamente, independentemente da sua natureza.",
      "Não existe qualquer relação matemática entre os erros individuais e o erro final."
    ],
    "answer": 0
  },
  {
    "id": 291,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(5, 23); P2(-1, 44); P3(33, 84); P4(37, 102). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "694.00 m²",
      "173.50 m²",
      "347.00 m²",
      "397.00 m²"
    ],
    "answer": 2
  },
  {
    "id": 292,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 424 m e um erro de fecho linear em Este de -0.64 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 84 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.254 m",
      "-0.640 m",
      "-0.127 m",
      "0.127 m"
    ],
    "answer": 3
  },
  {
    "id": 293,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(0, 21); P2(-9, 39); P3(20, 72); P4(37, 105). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "256.50 m²",
      "1026.00 m²",
      "563.00 m²",
      "513.00 m²"
    ],
    "answer": 3
  },
  {
    "id": 294,
    "section": 3,
    "text": "No cálculo de coordenadas de um ponto a partir de um ponto de estação conhecido, utilizando o azimute e a distância observados, aplica-se:",
    "options": [
      "Uma simples soma aritmética entre azimute e distância.",
      "Um processo que não pode ser realizado sem recurso a GPS.",
      "Trigonometria básica: a variação em Norte é dada pelo produto da distância pelo cosseno do azimute, e a variação em Este pelo produto da distância pelo seno do azimute.",
      "Apenas o teorema de Pitágoras, sem qualquer função trigonométrica."
    ],
    "answer": 2
  },
  {
    "id": 295,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 589 m e um erro de fecho linear em Este de -0.23 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 129 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "-0.230 m",
      "0.101 m",
      "-0.050 m",
      "0.050 m"
    ],
    "answer": 3
  },
  {
    "id": 296,
    "section": 3,
    "text": "Numa poligonal fechada com 10 vértices, a soma dos ângulos internos medidos foi 1439.6000°, sendo o valor teórico esperado 1440°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "24.00' por vértice",
      "2.67' por vértice",
      "2.40' por vértice",
      "-2.40' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 297,
    "section": 3,
    "text": "Um \"outlier\" (observação aberrante), num conjunto de dados topográficos, deve ser tratado com especial cuidado porque:",
    "options": [
      "Pode indicar um erro grosseiro na observação, devendo ser investigado e, se confirmado como erro, removido antes do ajustamento estatístico dos restantes dados.",
      "Deve ser sempre incluído no ajustamento, sem qualquer análise prévia, sem que seja necessária qualquer verificação ou confirmação adicional posterior, independentemente da experiência do operador.",
      "Não tem qualquer efeito no resultado final do ajustamento.",
      "É sempre um erro de cálculo do software, nunca da observação de campo."
    ],
    "answer": 0
  },
  {
    "id": 298,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 476 m, Norte = 220 m, observou-se um ponto com Azimute 14° e distância 38 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 476.00 m, Norte = 220.00 m",
      "Este = 485.19 m, Norte = 256.87 m",
      "Este = 466.81 m, Norte = 183.13 m, independentemente das condições do levantamento.",
      "Este = 512.87 m, Norte = 229.19 m"
    ],
    "answer": 1
  },
  {
    "id": 299,
    "section": 3,
    "text": "O método de Bowditch (ou da bússola), usado na compensação de poligonais, distribui o erro de fecho linear:",
    "options": [
      "Igualmente por todos os vértices, independentemente do comprimento dos lados.",
      "De forma aleatória, sem qualquer critério.",
      "Proporcionalmente ao comprimento de cada lado da poligonal em relação ao perímetro total.",
      "Apenas no último lado da poligonal, independentemente das condições específicas do levantamento e do tipo de terreno envolvido."
    ],
    "answer": 2
  },
  {
    "id": 300,
    "section": 3,
    "text": "O ajustamento de uma rede topográfica (por exemplo, pelo Método dos Mínimos Quadrados) tem como objectivo principal:",
    "options": [
      "Eliminar totalmente qualquer erro grosseiro presente nas observações.",
      "Substituir a necessidade de qualquer observação de campo.",
      "Aumentar artificialmente a precisão do instrumento utilizado, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, conforme adoptado na maioria dos projectos.",
      "Distribuir de forma estatisticamente óptima os erros residuais (após remoção de erros grosseiros) pelas observações de uma rede com redundância, obtendo o conjunto de coordenadas mais provável."
    ],
    "answer": 3
  },
  {
    "id": 301,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 468 m e um erro de fecho linear em Este de 0.30 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 59 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.300 m",
      "-0.038 m",
      "0.038 m",
      "-0.076 m"
    ],
    "answer": 1
  },
  {
    "id": 302,
    "section": 3,
    "text": "A escolha entre um ajustamento rigoroso (por Mínimos Quadrados) e um método de compensação simplificado (como o de Bowditch) depende, entre outros factores, de:",
    "options": [
      "Nunca haver qualquer diferença prática entre os dois métodos.",
      "Da precisão exigida pelo projecto, da complexidade da rede e dos recursos (software, tempo) disponíveis para o processamento.",
      "Ser sempre obrigatório usar Mínimos Quadrados em qualquer levantamento, por lei, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina.",
      "Da cor do terreno onde o levantamento foi realizado."
    ],
    "answer": 1
  },
  {
    "id": 303,
    "section": 3,
    "text": "Numa poligonal fechada com 5 vértices, a soma dos ângulos internos medidos foi 539.6000°, sendo o valor teórico esperado 540°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "6.00' por vértice",
      "-4.80' por vértice",
      "4.80' por vértice",
      "24.00' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 304,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(17, 29); P2(46, 32); P3(79, 52); P4(50, 86). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "1628.00 m²",
      "1678.00 m²",
      "814.00 m²",
      "3256.00 m²"
    ],
    "answer": 0
  },
  {
    "id": 305,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(35, 17); P2(42, 27); P3(17, 36); P4(14, 34). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "406.00 m²",
      "101.50 m²",
      "253.00 m²",
      "203.00 m²"
    ],
    "answer": 3
  },
  {
    "id": 306,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 286 m, Norte = 436 m, observou-se um ponto com Azimute 150° e distância 93 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 286.00 m, Norte = 436.00 m",
      "Este = 239.50 m, Norte = 516.54 m, independentemente das condições do levantamento.",
      "Este = 205.46 m, Norte = 482.50 m",
      "Este = 332.50 m, Norte = 355.46 m"
    ],
    "answer": 3
  },
  {
    "id": 307,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(40, 36); P2(73, 43); P3(53, 83); P4(38, 107). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "1288.50 m²",
      "2477.00 m²",
      "619.25 m²",
      "1238.50 m²"
    ],
    "answer": 3
  },
  {
    "id": 308,
    "section": 3,
    "text": "Numa poligonal fechada com 10 vértices, a soma dos ângulos internos medidos foi 1439.9000°, sendo o valor teórico esperado 1440°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "0.67' por vértice",
      "-0.60' por vértice",
      "0.60' por vértice",
      "6.00' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 309,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(31, 5); P2(63, 16); P3(99, 48); P4(91, 69). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "600.00 m²",
      "1250.00 m²",
      "2400.00 m²",
      "1200.00 m²"
    ],
    "answer": 3
  },
  {
    "id": 310,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 23 m² e 23 m², distando 42 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "966.0 m³",
      "1932.0 m³",
      "23.0 m³",
      "483.0 m³"
    ],
    "answer": 0
  },
  {
    "id": 311,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 411 m e um erro de fecho linear em Este de 0.16 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 129 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.050 m",
      "-0.050 m",
      "-0.100 m",
      "0.160 m"
    ],
    "answer": 1
  },
  {
    "id": 312,
    "section": 3,
    "text": "Numa poligonal fechada com 9 vértices, a soma dos ângulos internos medidos foi 1260.5000°, sendo o valor teórico esperado 1260°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-30.00' por vértice",
      "3.33' por vértice",
      "-3.33' por vértice",
      "-3.75' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 313,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 813 m e um erro de fecho linear em Este de 0.16 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 119 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.023 m",
      "-0.023 m",
      "0.160 m",
      "-0.047 m"
    ],
    "answer": 1
  },
  {
    "id": 314,
    "section": 3,
    "text": "No cálculo do volume de um aterro ou escavação por prismóides (fórmula de Simpson), em relação ao método simples das áreas médias, a principal diferença é:",
    "options": [
      "Considerar também a área da secção intermédia (a meio da distância entre as duas secções extremas), obtendo geralmente um resultado mais rigoroso.",
      "Aplicar-se apenas a secções transversais circulares.",
      "Não ter qualquer relação com o cálculo de terraplenagens.",
      "Ignorar totalmente a distância entre secções."
    ],
    "answer": 0
  },
  {
    "id": 315,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(34, 25); P2(44, 21); P3(69, 47); P4(88, 64). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "268.50 m²",
      "537.00 m²",
      "318.50 m²",
      "134.25 m²"
    ],
    "answer": 0
  },
  {
    "id": 316,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 18 m² e 58 m², distando 49 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "1862.0 m³",
      "3724.0 m³",
      "931.0 m³",
      "38.0 m³"
    ],
    "answer": 0
  },
  {
    "id": 317,
    "section": 3,
    "text": "Numa poligonal fechada com 8 vértices, a soma dos ângulos internos medidos foi 1079.7000°, sendo o valor teórico esperado 1080°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "2.57' por vértice",
      "-2.25' por vértice",
      "18.00' por vértice",
      "2.25' por vértice"
    ],
    "answer": 3
  },
  {
    "id": 318,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 886 m, Norte = 538 m, observou-se um ponto com Azimute 21° e distância 69 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 950.42 m, Norte = 562.73 m",
      "Este = 910.73 m, Norte = 602.42 m",
      "Este = 861.27 m, Norte = 473.58 m, tal como recomendado pelos fabricantes.",
      "Este = 886.00 m, Norte = 538.00 m"
    ],
    "answer": 1
  },
  {
    "id": 319,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(36, 6); P2(60, 17); P3(42, 34); P4(62, 34). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "73.00 m²",
      "23.00 m²",
      "46.00 m²",
      "11.50 m²"
    ],
    "answer": 1
  },
  {
    "id": 320,
    "section": 3,
    "text": "O erro de fecho angular de uma poligonal corresponde a:",
    "options": [
      "Irrelevante para o cálculo de coordenadas finais, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo, sendo esta a prática mais comum em campo.",
      "Um valor fixo, independente do número de observações.",
      "Sempre zero, por definição.",
      "A diferença entre a soma dos ângulos medidos e a soma teórica esperada, valor que deve ser distribuído (compensado) pelos vértices da poligonal."
    ],
    "answer": 3
  },
  {
    "id": 321,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(33, 6); P2(39, 5); P3(9, 5); P4(45, 41). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "214.50 m²",
      "429.00 m²",
      "479.00 m²",
      "858.00 m²"
    ],
    "answer": 1
  },
  {
    "id": 322,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 9 m² e 17 m², distando 32 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "208.0 m³",
      "416.0 m³",
      "832.0 m³",
      "13.0 m³"
    ],
    "answer": 1
  },
  {
    "id": 323,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 736 m e um erro de fecho linear em Este de -0.11 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 83 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.025 m",
      "-0.012 m",
      "0.012 m",
      "-0.110 m"
    ],
    "answer": 2
  },
  {
    "id": 324,
    "section": 3,
    "text": "Numa poligonal fechada com 8 vértices, a soma dos ângulos internos medidos foi 1080.1000°, sendo o valor teórico esperado 1080°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-6.00' por vértice",
      "0.75' por vértice",
      "-0.86' por vértice",
      "-0.75' por vértice"
    ],
    "answer": 3
  },
  {
    "id": 325,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(26, 15); P2(35, 24); P3(37, 63); P4(69, 99). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "453.50 m²",
      "201.75 m²",
      "403.50 m²",
      "807.00 m²"
    ],
    "answer": 2
  },
  {
    "id": 326,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(4, 9); P2(5, 48); P3(-21, 82); P4(-8, 116). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "425.50 m²",
      "751.00 m²",
      "187.75 m²",
      "375.50 m²"
    ],
    "answer": 3
  },
  {
    "id": 327,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 8 m² e 35 m², distando 14 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "301.0 m³",
      "602.0 m³",
      "150.5 m³",
      "21.5 m³"
    ],
    "answer": 0
  },
  {
    "id": 328,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 27 m² e 40 m², distando 53 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "3551.0 m³",
      "887.8 m³",
      "33.5 m³",
      "1775.5 m³"
    ],
    "answer": 3
  },
  {
    "id": 329,
    "section": 3,
    "text": "Num ajustamento de uma rede de nivelamento com múltiplos circuitos fechados, o erro de fecho de cada circuito é utilizado para:",
    "options": [
      "Calcular directamente a escala da carta final.",
      "Substituir a necessidade de qualquer observação de campo adicional.",
      "Nada, sendo apenas um valor informativo sem qualquer uso prático.",
      "Distribuir proporcionalmente as correcções pelos desníveis observados em cada circuito, de forma consistente com o número e a distribuição das estações."
    ],
    "answer": 3
  },
  {
    "id": 330,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(29, 38); P2(52, 57); P3(92, 67); P4(131, 70). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "786.00 m²",
      "736.00 m²",
      "368.00 m²",
      "1472.00 m²"
    ],
    "answer": 1
  },
  {
    "id": 331,
    "section": 3,
    "text": "O método de cálculo de área de um polígono a partir das coordenadas dos seus vértices (método de Gauss/Shoelace) é preferido em relação a métodos gráficos porque:",
    "options": [
      "Só pode ser aplicado a polígonos regulares.",
      "Dispensa totalmente a necessidade de conhecer as coordenadas dos vértices, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina.",
      "É sempre menos preciso do que a medição directa com planímetro sobre a carta.",
      "Permite um cálculo analítico exacto, dependente apenas da qualidade das coordenadas, sem os erros associados à medição gráfica sobre papel."
    ],
    "answer": 3
  },
  {
    "id": 332,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 1153 m e um erro de fecho linear em Este de -0.18 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 355 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.111 m",
      "0.055 m",
      "-0.180 m",
      "-0.055 m"
    ],
    "answer": 1
  },
  {
    "id": 333,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 411 m e um erro de fecho linear em Este de -0.06 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 115 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "-0.017 m",
      "0.017 m",
      "0.034 m",
      "-0.060 m"
    ],
    "answer": 1
  },
  {
    "id": 334,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 574 m e um erro de fecho linear em Este de -0.48 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 94 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.079 m",
      "-0.480 m",
      "0.157 m",
      "-0.079 m"
    ],
    "answer": 0
  },
  {
    "id": 335,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 258 m, Norte = 528 m, observou-se um ponto com Azimute 259° e distância 196 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 65.60 m, Norte = 490.60 m",
      "Este = 258.00 m, Norte = 528.00 m",
      "Este = 450.40 m, Norte = 565.40 m",
      "Este = 220.60 m, Norte = 335.60 m"
    ],
    "answer": 0
  },
  {
    "id": 336,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 699 m e um erro de fecho linear em Este de 0.39 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 68 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.038 m",
      "-0.076 m",
      "-0.038 m",
      "0.390 m"
    ],
    "answer": 2
  },
  {
    "id": 337,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(13, 8); P2(50, -2); P3(70, 23); P4(97, 15). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "66.00 m²",
      "182.00 m²",
      "264.00 m²",
      "132.00 m²"
    ],
    "answer": 3
  },
  {
    "id": 338,
    "section": 3,
    "text": "Uma poligonal fechada tem um perímetro total de 496 m e um erro de fecho linear em Este de 0.08 m. Pelo método de Bowditch (compass rule), qual a correcção a aplicar (em Este) a um lado com 142 m de comprimento, proporcionalmente ao seu comprimento? (Correcção = −erro × lado/perímetro)",
    "options": [
      "0.023 m",
      "0.080 m",
      "-0.023 m",
      "-0.046 m"
    ],
    "answer": 2
  },
  {
    "id": 339,
    "section": 3,
    "text": "A verificação de fecho de uma poligonal, comparando as coordenadas calculadas do ponto final com as coordenadas conhecidas (ou esperadas) desse mesmo ponto, é uma etapa:",
    "options": [
      "Que só se aplica a poligonais abertas.",
      "Fundamental do processo de cálculo, permitindo detectar e quantificar o erro acumulado antes da fase de compensação/ajustamento.",
      "Dispensável, desde que os ângulos tenham sido bem medidos, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Relevante apenas para levantamentos batimétricos."
    ],
    "answer": 1
  },
  {
    "id": 340,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 201 m, Norte = 431 m, observou-se um ponto com Azimute 269° e distância 148 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 201.00 m, Norte = 431.00 m",
      "Este = 53.02 m, Norte = 428.42 m",
      "Este = 198.42 m, Norte = 283.02 m",
      "Este = 348.98 m, Norte = 433.58 m"
    ],
    "answer": 1
  },
  {
    "id": 341,
    "section": 3,
    "text": "No cálculo de uma área por coordenadas, a ordem (sentido horário ou anti-horário) em que os vértices do polígono são introduzidos no cálculo:",
    "options": [
      "Pode determinar o sinal do resultado (positivo ou negativo), devendo o valor absoluto ser considerado como a área correcta.",
      "Torna o cálculo impossível de realizar.",
      "É irrelevante para qualquer efeito do cálculo, sendo esta uma prática amplamente disseminada entre topógrafos com maior experiência.",
      "Só é relevante para polígonos com mais de 10 vértices."
    ],
    "answer": 0
  },
  {
    "id": 342,
    "section": 3,
    "text": "A partir do ponto de coordenadas Este = 832 m, Norte = 340 m, observou-se um ponto com Azimute 336° e distância 160 m. Quais são as coordenadas do novo ponto? (ΔEste = D·sen(Az); ΔNorte = D·cos(Az))",
    "options": [
      "Este = 978.17 m, Norte = 274.92 m, conforme adoptado na maioria dos projectos.",
      "Este = 766.92 m, Norte = 486.17 m",
      "Este = 897.08 m, Norte = 193.83 m",
      "Este = 832.00 m, Norte = 340.00 m"
    ],
    "answer": 1
  },
  {
    "id": 343,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(13, 32); P2(45, 27); P3(44, 29); P4(39, 66). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "595.50 m²",
      "1191.00 m²",
      "645.50 m²",
      "297.75 m²"
    ],
    "answer": 0
  },
  {
    "id": 344,
    "section": 3,
    "text": "Numa poligonal fechada com 9 vértices, a soma dos ângulos internos medidos foi 1259.9000°, sendo o valor teórico esperado 1260°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-0.67' por vértice",
      "0.75' por vértice",
      "6.00' por vértice",
      "0.67' por vértice"
    ],
    "answer": 3
  },
  {
    "id": 345,
    "section": 3,
    "text": "Numa poligonal fechada com 9 vértices, a soma dos ângulos internos medidos foi 1260.5000°, sendo o valor teórico esperado 1260°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "3.33' por vértice",
      "-3.75' por vértice",
      "-3.33' por vértice",
      "-30.00' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 346,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(9, 32); P2(-9, 60); P3(2, 81); P4(25, 100). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "1946.00 m²",
      "1023.00 m²",
      "973.00 m²",
      "486.50 m²"
    ],
    "answer": 2
  },
  {
    "id": 347,
    "section": 3,
    "text": "A tolerância de fecho aceitável para uma poligonal ou circuito de nivelamento deve ser definida:",
    "options": [
      "De forma arbitrária, sem qualquer critério técnico.",
      "De forma idêntica para qualquer tipo de projecto, independentemente da sua finalidade, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Previamente, com base na precisão exigida pelo projecto e na precisão nominal dos instrumentos e métodos utilizados, servindo de critério de aceitação ou rejeição do levantamento.",
      "Apenas depois de concluído todo o levantamento, sem qualquer planeamento prévio."
    ],
    "answer": 2
  },
  {
    "id": 348,
    "section": 3,
    "text": "Numa poligonal fechada com 7 vértices, a soma dos ângulos internos medidos foi 899.7000°, sendo o valor teórico esperado 900°. Distribuindo o erro de fecho igualmente por todos os vértices, qual a correcção angular a aplicar a cada vértice (em minutos de arco)?",
    "options": [
      "-2.57' por vértice",
      "18.00' por vértice",
      "2.57' por vértice",
      "3.00' por vértice"
    ],
    "answer": 2
  },
  {
    "id": 349,
    "section": 3,
    "text": "Um polígono (talhão) tem os vértices com as seguintes coordenadas (Este, Norte), em metros: P1(39, 0); P2(32, -6); P3(65, 22); P4(94, 31). Aplicando o método das coordenadas (Gauss/Shoelace), qual é a área aproximada do polígono?",
    "options": [
      "402.00 m²",
      "201.00 m²",
      "100.50 m²",
      "251.00 m²"
    ],
    "answer": 1
  },
  {
    "id": 350,
    "section": 3,
    "text": "Duas secções transversais consecutivas de um projecto de terraplenagem têm áreas de 54 m² e 21 m², distando 14 m entre si. Pelo método das áreas médias, qual é o volume de terra entre estas duas secções?",
    "options": [
      "262.5 m³",
      "1050.0 m³",
      "37.5 m³",
      "525.0 m³"
    ],
    "answer": 3
  },
  {
    "id": 351,
    "section": 4,
    "text": "Para trabalhos de engenharia e topografia de detalhe, as coordenadas planas (projectadas) são geralmente preferidas às coordenadas geodésicas porque:",
    "options": [
      "Não podem, de todo, ser convertidas em coordenadas geodésicas, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, independentemente do equipamento utilizado.",
      "Permitem cálculos directos de distâncias e áreas através de simples geometria plana (Pitágoras, trigonometria plana), mais simples do que os cálculos em coordenadas angulares sobre o elipsóide.",
      "Dispensam totalmente a necessidade de qualquer Datum de referência.",
      "São sempre mais precisas do que as coordenadas geodésicas, em qualquer circunstância."
    ],
    "answer": 1
  },
  {
    "id": 352,
    "section": 4,
    "text": "A ortorrectificação de uma imagem aérea ou de satélite tem como objectivo:",
    "options": [
      "Corrigir as deformações geométricas causadas pelo relevo do terreno e pela inclinação da câmara, produzindo uma imagem com escala uniforme (ortofoto).",
      "Aumentar artificialmente a resolução da imagem, sem qualquer correcção geométrica.",
      "Substituir totalmente a necessidade de qualquer sistema de coordenadas.",
      "Aplicar apenas um filtro de cor à imagem original, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, conforme adoptado na maioria dos projectos."
    ],
    "answer": 0
  },
  {
    "id": 353,
    "section": 4,
    "text": "A deteção remota (remote sensing), como a análise de imagens de satélite, permite obter informação sobre o território sem:",
    "options": [
      "Nunca poder ser integrada num SIG.",
      "Qualquer relação com trabalhos de cartografia.",
      "Contacto físico directo com a área observada, através da captação de radiação electromagnética reflectida ou emitida pela superfície.",
      "Qualquer necessidade de processamento posterior da imagem."
    ],
    "answer": 2
  },
  {
    "id": 354,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 40°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 38",
      "Fuso 36",
      "Fuso 37",
      "Fuso 35"
    ],
    "answer": 2
  },
  {
    "id": 355,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:25 000, a distância entre dois pontos, medida directamente sobre a carta, é de 20 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "2500.00 m",
      "5000.00 m",
      "500.00 m",
      "50000.00 m"
    ],
    "answer": 1
  },
  {
    "id": 356,
    "section": 4,
    "text": "O Norte verdadeiro (ou geográfico) corresponde à direcção:",
    "options": [
      "Definida arbitrariamente pelo utilizador do mapa.",
      "Indicada pela agulha de uma bússola magnética.",
      "Do meridiano central de qualquer fuso UTM, em qualquer ponto do fuso.",
      "Do eixo de rotação da Terra, apontando para o Pólo Norte geográfico."
    ],
    "answer": 3
  },
  {
    "id": 357,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:5000, a distância entre dois pontos, medida directamente sobre a carta, é de 11 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "55.00 m",
      "5500.00 m",
      "275.00 m",
      "550.00 m"
    ],
    "answer": 3
  },
  {
    "id": 358,
    "section": 4,
    "text": "A altitude ortométrica (relacionada com o geóide, aproximadamente o nível médio do mar) distingue-se da altitude elipsoidal (relacionada com o elipsóide de referência, tipicamente obtida por GPS) porque:",
    "options": [
      "A altitude elipsoidal nunca pode ser medida por GPS.",
      "São sempre exactamente iguais, em qualquer ponto da Terra, conforme o entendimento tradicional sobre a matéria.",
      "A altitude ortométrica é sempre superior à elipsoidal, em qualquer lugar do mundo.",
      "Diferem entre si por um valor designado como ondulação geoidal, que varia de local para local."
    ],
    "answer": 3
  },
  {
    "id": 359,
    "section": 4,
    "text": "O Datum geodésico de um sistema de coordenadas define, essencialmente:",
    "options": [
      "O fuso horário local da área representada.",
      "A cor utilizada na representação cartográfica.",
      "Apenas o nome do sistema, sem qualquer implicação técnica.",
      "A superfície de referência (geralmente um elipsóide) e o seu posicionamento relativamente à Terra, servindo de base ao cálculo de coordenadas."
    ],
    "answer": 3
  },
  {
    "id": 360,
    "section": 4,
    "text": "A fotogrametria, enquanto técnica de levantamento, baseia-se em:",
    "options": [
      "Obter medições (posições, formas, dimensões) de objectos a partir da análise de fotografias, geralmente aéreas ou obtidas por drone.",
      "Um método que dispensa totalmente qualquer ponto de controlo terrestre para qualquer finalidade.",
      "Uma técnica exclusiva de levantamentos subaquáticos, sem que seja necessária qualquer verificação ou confirmação adicional posterior.",
      "Medições directas efectuadas exclusivamente em campo, sem qualquer uso de imagens."
    ],
    "answer": 0
  },
  {
    "id": 361,
    "section": 4,
    "text": "A legenda de uma carta topográfica tem como função:",
    "options": [
      "Indicar apenas o nome do autor da carta.",
      "Substituir a necessidade de qualquer escala gráfica.",
      "Indicar exclusivamente a data de impressão, conforme geralmente indicado nos manuais técnicos de referência da área.",
      "Explicar o significado dos símbolos, cores e convenções utilizadas na representação cartográfica."
    ],
    "answer": 3
  },
  {
    "id": 362,
    "section": 4,
    "text": "Os símbolos convencionais utilizados em cartografia (por exemplo, para igrejas, escolas, marcos geodésicos) têm como objectivo:",
    "options": [
      "Ser definidos livremente por cada topógrafo, sem qualquer convenção comum.",
      "Representar de forma padronizada e reconhecível elementos do terreno, sem depender da escala exacta desses elementos.",
      "Substituir totalmente a necessidade de qualquer legenda, independentemente do tipo e da marca de equipamento efectivamente utilizado.",
      "Complicar desnecessariamente a leitura da carta."
    ],
    "answer": 1
  },
  {
    "id": 363,
    "section": 4,
    "text": "A cor castanha (ou sépia), em muitas cartas topográficas, é geralmente associada a:",
    "options": [
      "Rede hidrográfica.",
      "Zonas urbanas edificadas.",
      "Curvas de nível e representação do relevo.",
      "Vegetação e áreas florestais."
    ],
    "answer": 2
  },
  {
    "id": 364,
    "section": 4,
    "text": "Em muitas convenções cartográficas, a cor azul é tipicamente utilizada para representar:",
    "options": [
      "Limites administrativos.",
      "Áreas de vegetação florestal.",
      "Vias de comunicação (estradas), conforme adoptado na maioria dos projectos.",
      "Elementos hidrográficos, como rios, lagos e o mar."
    ],
    "answer": 3
  },
  {
    "id": 365,
    "section": 4,
    "text": "A utilização de Datums diferentes (por exemplo, um Datum local antigo e o WGS84) para o mesmo território pode resultar em:",
    "options": [
      "Nenhuma diferença relevante, desde que a escala da carta seja a mesma.",
      "Uma alteração automática e transparente, sem necessidade de qualquer cálculo.",
      "Coordenadas idênticas em ambos os sistemas, sem qualquer diferença, independentemente das condições específicas do levantamento e do tipo de terreno envolvido.",
      "Discrepâncias de posição entre os dois sistemas, exigindo uma transformação de coordenadas com parâmetros adequados para compatibilizar os dados."
    ],
    "answer": 3
  },
  {
    "id": 366,
    "section": 4,
    "text": "A declinação magnética de um determinado local, necessária para converter rumos/azimutes magnéticos em verdadeiros (ou vice-versa), deve ser:",
    "options": [
      "Aplicável apenas a levantamentos realizados no hemisfério norte.",
      "Ignorada em qualquer levantamento topográfico moderno, independentemente das condições específicas do levantamento e do tipo de terreno envolvido.",
      "Consultada para o local e data específicos, uma vez que varia geograficamente e ao longo do tempo.",
      "Considerada como um valor fixo e universal, igual em qualquer ponto do planeta."
    ],
    "answer": 2
  },
  {
    "id": 367,
    "section": 4,
    "text": "A actualização e manutenção de uma base de dados cartográfica digital (por exemplo, um cadastro de topógrafos ou de propriedades) é importante porque:",
    "options": [
      "Os dados geográficos, uma vez recolhidos, nunca precisam de qualquer actualização.",
      "Aplica-se apenas a dados de natureza hidrográfica.",
      "É uma exigência meramente estética, sem qualquer valor prático.",
      "O território e as suas características estão em constante mudança, sendo necessário actualizar periodicamente os dados para garantir a sua utilidade e fiabilidade."
    ],
    "answer": 3
  },
  {
    "id": 368,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 40°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 36",
      "Fuso 37",
      "Fuso 38",
      "Fuso 35"
    ],
    "answer": 1
  },
  {
    "id": 369,
    "section": 4,
    "text": "A projecção de Gauss-Krüger, utilizada nalguns países como base de sistemas cartográficos nacionais, é conceptualmente semelhante à UTM porque:",
    "options": [
      "Não têm qualquer relação matemática entre si.",
      "São exactamente o mesmo sistema, apenas com nomes diferentes.",
      "Nenhuma das duas é uma projecção conforme.",
      "Ambas são projecções cilíndricas transversas conformes, baseadas em princípios matemáticos semelhantes, embora possam diferir nos parâmetros (fuso, factor de escala, origem)."
    ],
    "answer": 3
  },
  {
    "id": 370,
    "section": 4,
    "text": "O Norte magnético distingue-se do Norte verdadeiro porque:",
    "options": [
      "É indicado pela agulha de uma bússola, apontando para o pólo magnético da Terra, que não coincide exactamente com o pólo geográfico, e varia ligeiramente ao longo do tempo.",
      "Só existe em cartas de escala muito grande, sem que seja necessária qualquer verificação ou confirmação adicional posterior, independentemente das condições do levantamento.",
      "É uma direcção fixa e imutável, definida por lei em cada país.",
      "São sempre exactamente coincidentes, em qualquer local e momento."
    ],
    "answer": 0
  },
  {
    "id": 371,
    "section": 4,
    "text": "Uma carta de escala 1:10.000 é considerada, em relação a uma carta de escala 1:100.000:",
    "options": [
      "Exactamente com o mesmo nível de detalhe.",
      "De escala maior e, por isso, com maior nível de detalhe para a mesma área impressa.",
      "De escala menor e, por isso, com menor detalhe.",
      "Inutilizável para fins topográficos, independentemente do tipo e da marca de equipamento efectivamente utilizado."
    ],
    "answer": 1
  },
  {
    "id": 372,
    "section": 4,
    "text": "As coordenadas geodésicas (latitude e longitude) distinguem-se das coordenadas planas (por exemplo, UTM, em metros) porque:",
    "options": [
      "São exactamente o mesmo tipo de coordenadas, apenas com nomes diferentes.",
      "As geodésicas são expressas em unidades angulares (graus, minutos, segundos) sobre o elipsóide, enquanto as planas resultam de uma projecção cartográfica, expressas em unidades lineares (metros).",
      "As coordenadas planas nunca podem ser convertidas em coordenadas geodésicas, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico, sendo esta a prática mais comum em campo.",
      "As coordenadas geodésicas só existem em Angola."
    ],
    "answer": 1
  },
  {
    "id": 373,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 96°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 46",
      "Fuso 48",
      "Fuso 45",
      "Fuso 47"
    ],
    "answer": 3
  },
  {
    "id": 374,
    "section": 4,
    "text": "A equidistância (intervalo) entre curvas de nível consecutivas, numa carta, relaciona-se com:",
    "options": [
      "Não tem qualquer relação com a escala da carta.",
      "É sempre fixa em 100 metros, independentemente da carta, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector.",
      "Depende apenas da cor utilizada na impressão.",
      "A escala da carta e o nível de detalhe do relevo pretendido, sendo tipicamente menor em cartas de maior escala."
    ],
    "answer": 3
  },
  {
    "id": 375,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:5000, a distância entre dois pontos, medida directamente sobre a carta, é de 24 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "120.00 m",
      "12000.00 m",
      "1200.00 m",
      "600.00 m"
    ],
    "answer": 2
  },
  {
    "id": 376,
    "section": 4,
    "text": "Um Sistema de Informação Geográfica (SIG/GIS) é definido, de forma geral, como:",
    "options": [
      "Um simples programa de desenho, sem qualquer componente de dados geográficos.",
      "Um tipo específico de projecção cartográfica, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina, conforme os manuais técnicos da área.",
      "Um sistema que integra, armazena, analisa e representa dados georreferenciados, associando informação espacial a atributos descritivos.",
      "Um instrumento de medição de campo, semelhante à Estação Total."
    ],
    "answer": 2
  },
  {
    "id": 377,
    "section": 4,
    "text": "A escala numérica de uma carta topográfica, por exemplo 1:25.000, significa que:",
    "options": [
      "A carta foi produzida no ano de 2025, independentemente do tipo e da marca de equipamento efectivamente utilizado.",
      "Uma unidade de medida na carta corresponde a 25.000 dessa mesma unidade no terreno real.",
      "A carta representa uma área de 25.000 metros quadrados.",
      "Existem 25.000 curvas de nível representadas na carta."
    ],
    "answer": 1
  },
  {
    "id": 378,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:10 000, a distância entre dois pontos, medida directamente sobre a carta, é de 4 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "4000.00 m",
      "40.00 m",
      "200.00 m",
      "400.00 m"
    ],
    "answer": 3
  },
  {
    "id": 379,
    "section": 4,
    "text": "Um ponto localiza-se à longitude -58°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 20",
      "Fuso 21",
      "Fuso 22",
      "Fuso 19"
    ],
    "answer": 1
  },
  {
    "id": 380,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 143°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 53",
      "Fuso 55",
      "Fuso 52",
      "Fuso 54"
    ],
    "answer": 3
  },
  {
    "id": 381,
    "section": 4,
    "text": "Num SIG, a distinção entre dados vectoriais e dados matriciais (raster) relaciona-se com:",
    "options": [
      "Os dados vectoriais representam a informação através de pontos, linhas e polígonos com geometria definida; os dados raster representam a informação através de uma grelha regular de células (pixels).",
      "São exactamente o mesmo tipo de dado, apenas com nomes diferentes.",
      "Os dados vectoriais só podem representar pontos, nunca linhas ou áreas.",
      "Os dados raster nunca podem representar imagens de satélite, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo, sem necessidade de verificação adicional."
    ],
    "answer": 0
  },
  {
    "id": 382,
    "section": 4,
    "text": "A representação do relevo através de um Modelo Digital de Terreno (MDT), em complemento ou substituição das curvas de nível tradicionais, permite:",
    "options": [
      "Ser usado exclusivamente em cartografia marítima.",
      "Substituir totalmente a necessidade de qualquer levantamento de campo.",
      "Apenas uma representação bidimensional simples, sem qualquer valor de altitude associado.",
      "Análises tridimensionais do terreno (perfis, cálculo de volumes, visibilidade), a partir de uma grelha ou malha de pontos com coordenadas X, Y e Z."
    ],
    "answer": 3
  },
  {
    "id": 383,
    "section": 4,
    "text": "A escolha da escala de um levantamento ou de uma carta a produzir depende principalmente de:",
    "options": [
      "Apenas da preferência estética do topógrafo, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "Do tipo de papel disponível na impressora.",
      "Da cor predominante do terreno observado.",
      "Da finalidade do trabalho, do nível de detalhe exigido e da extensão da área a representar."
    ],
    "answer": 3
  },
  {
    "id": 384,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:10 000, a distância entre dois pontos, medida directamente sobre a carta, é de 28 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "28000.00 m",
      "280.00 m",
      "2800.00 m",
      "1400.00 m"
    ],
    "answer": 2
  },
  {
    "id": 385,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:2000, a distância entre dois pontos, medida directamente sobre a carta, é de 8 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "1600.00 m",
      "16.00 m",
      "80.00 m",
      "160.00 m"
    ],
    "answer": 3
  },
  {
    "id": 386,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 113°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 47",
      "Fuso 49",
      "Fuso 48",
      "Fuso 50"
    ],
    "answer": 1
  },
  {
    "id": 387,
    "section": 4,
    "text": "Um elipsóide de referência, em geodesia, é utilizado para:",
    "options": [
      "Indicar exclusivamente a profundidade dos oceanos.",
      "Definir apenas a escala de uma carta.",
      "Substituir totalmente a necessidade de qualquer sistema de coordenadas, sem que seja necessária qualquer verificação ou confirmação adicional posterior.",
      "Aproximar matematicamente a forma da Terra, servindo de superfície de referência para o cálculo de coordenadas geodésicas."
    ],
    "answer": 3
  },
  {
    "id": 388,
    "section": 4,
    "text": "O factor de escala numa projecção UTM varia dentro do fuso porque:",
    "options": [
      "A projecção é perfeita e não introduz qualquer deformação.",
      "Depende apenas da altitude do ponto, sem qualquer relação com a longitude, independentemente das condições específicas do levantamento e do tipo de terreno envolvido, independentemente da escala do levantamento.",
      "O factor de escala é sempre exactamente igual a 1 em toda a extensão do fuso.",
      "A deformação da projecção aumenta à medida que nos afastamos do meridiano central do fuso, sendo o factor de escala ligeiramente inferior a 1 junto ao meridiano central e superior a 1 nos limites do fuso."
    ],
    "answer": 3
  },
  {
    "id": 389,
    "section": 4,
    "text": "Para determinar a distância real no terreno a partir de uma medição feita sobre uma carta à escala 1:50.000, deve-se:",
    "options": [
      "Dividir a medição na carta pelo denominador da escala, independentemente da experiência do operador.",
      "Multiplicar a medição feita na carta pelo denominador da escala (50.000).",
      "A escala não tem qualquer relação com o cálculo de distâncias reais.",
      "Somar 50.000 à medição feita na carta."
    ],
    "answer": 1
  },
  {
    "id": 390,
    "section": 4,
    "text": "Uma carta de escala 1:1.000, tipicamente usada em levantamentos cadastrais urbanos de detalhe, é considerada uma escala:",
    "options": [
      "Muito grande, adequada à representação detalhada de pequenas áreas, como lotes urbanos.",
      "Idêntica, em termos de detalhe, a uma escala 1:250.000.",
      "Muito pequena, adequada apenas a mapas-múndi.",
      "Inexistente na prática cartográfica, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector."
    ],
    "answer": 0
  },
  {
    "id": 391,
    "section": 4,
    "text": "Um ponto localiza-se à longitude -168°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 4",
      "Fuso 1",
      "Fuso 2",
      "Fuso 3"
    ],
    "answer": 3
  },
  {
    "id": 392,
    "section": 4,
    "text": "A resolução espacial de uma imagem de satélite ou aérea refere-se a:",
    "options": [
      "O sistema de coordenadas utilizado na imagem.",
      "A quantidade de cores que a imagem pode representar.",
      "A data em que a imagem foi capturada.",
      "O tamanho da menor área do terreno representada por um único pixel da imagem, determinando o nível de detalhe visível."
    ],
    "answer": 3
  },
  {
    "id": 393,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:5000, a distância entre dois pontos, medida directamente sobre a carta, é de 20 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "10000.00 m",
      "100.00 m",
      "1000.00 m",
      "500.00 m"
    ],
    "answer": 2
  },
  {
    "id": 394,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:5000, a distância entre dois pontos, medida directamente sobre a carta, é de 2 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "100.00 m",
      "1000.00 m",
      "50.00 m",
      "10.00 m"
    ],
    "answer": 0
  },
  {
    "id": 395,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 67°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 42",
      "Fuso 43",
      "Fuso 40",
      "Fuso 41"
    ],
    "answer": 0
  },
  {
    "id": 396,
    "section": 4,
    "text": "O Norte de quadrícula (ou Norte da grelha) corresponde a:",
    "options": [
      "A direcção Norte definida pelas linhas verticais da grelha de coordenadas de uma determinada projecção cartográfica (por exemplo, UTM), que geralmente não coincide exactamente com o Norte verdadeiro, excepto ao longo do meridiano central do fuso.",
      "Uma direcção que só existe em levantamentos batimétricos.",
      "Sempre exactamente à mesma direcção do Norte magnético.",
      "O Norte indicado directamente pelo GPS, sem qualquer relação com a projecção cartográfica, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector, sem necessidade de verificação adicional."
    ],
    "answer": 0
  },
  {
    "id": 397,
    "section": 4,
    "text": "Um ponto localiza-se à longitude -120°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 11",
      "Fuso 9",
      "Fuso 10",
      "Fuso 12"
    ],
    "answer": 0
  },
  {
    "id": 398,
    "section": 4,
    "text": "O Datum WGS84 (World Geodetic System 1984) é amplamente utilizado porque:",
    "options": [
      "Foi definido antes da invenção do GPS e está desactualizado.",
      "É um sistema de referência exclusivo de Angola, tal como é habitualmente recomendado pela maioria dos fabricantes de equipamento topográfico.",
      "É o sistema de referência global adoptado pelo GPS e por grande parte dos sistemas GNSS modernos.",
      "Não pode ser usado em conjunto com qualquer projecção cartográfica."
    ],
    "answer": 2
  },
  {
    "id": 399,
    "section": 4,
    "text": "A conversão de coordenadas geodésicas para coordenadas UTM (planas) é realizada através de:",
    "options": [
      "Uma tabela de conversão universal, válida para qualquer Datum, sem necessidade de qualquer fórmula.",
      "Um processo impossível de automatizar em software, o que, na prática, simplifica consideravelmente o trabalho do topógrafo em campo.",
      "Fórmulas matemáticas específicas da projecção UTM, que dependem do elipsóide de referência e dos parâmetros do fuso considerado.",
      "Uma simples soma aritmética dos valores de latitude e longitude."
    ],
    "answer": 2
  },
  {
    "id": 400,
    "section": 4,
    "text": "Uma curva de nível mestra (mais espessa, geralmente cotada) distingue-se das curvas de nível intermédias porque:",
    "options": [
      "Não tem qualquer relação com as demais curvas de nível.",
      "É usada apenas em cartas rodoviárias, conforme geralmente indicado nos manuais técnicos de referência da área, independentemente das condições do levantamento.",
      "Representa sempre uma altitude inferior às restantes.",
      "É desenhada com destaque (traço mais grosso e cotada numericamente) a intervalos regulares, geralmente a cada 4 ou 5 curvas, para facilitar a leitura do relevo."
    ],
    "answer": 3
  },
  {
    "id": 401,
    "section": 4,
    "text": "A latitude de um ponto, num sistema de coordenadas geodésicas, corresponde a:",
    "options": [
      "A distância linear entre dois pontos, expressa em metros.",
      "A distância angular medida ao longo do meridiano, entre o Equador e o ponto considerado.",
      "A distância angular medida ao longo do paralelo, entre o meridiano de referência e o ponto considerado.",
      "A altitude do ponto acima do nível médio do mar."
    ],
    "answer": 1
  },
  {
    "id": 402,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 6°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 31",
      "Fuso 32",
      "Fuso 33",
      "Fuso 30"
    ],
    "answer": 1
  },
  {
    "id": 403,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 161°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 55",
      "Fuso 58",
      "Fuso 56",
      "Fuso 57"
    ],
    "answer": 3
  },
  {
    "id": 404,
    "section": 4,
    "text": "Uma projecção cartográfica é necessária porque:",
    "options": [
      "É apenas uma tradição histórica, sem qualquer necessidade técnica actual.",
      "A Terra é uma superfície curva (aproximadamente elipsoidal) e as cartas são representações num plano, exigindo uma transformação matemática que introduz sempre algum tipo de deformação.",
      "Serve exclusivamente para definir a escala da carta.",
      "As cartas topográficas nunca representam áreas curvas."
    ],
    "answer": 1
  },
  {
    "id": 405,
    "section": 4,
    "text": "O formato shapefile (.shp), amplamente utilizado em SIG, é um exemplo de:",
    "options": [
      "Um formato usado apenas para armazenar texto sem qualquer componente espacial, conforme os manuais técnicos da área.",
      "Um formato de dados vectoriais, capaz de armazenar geometria e atributos associados a elementos geográficos.",
      "Um formato de dados raster exclusivamente.",
      "Um formato exclusivo de imagens de satélite."
    ],
    "answer": 1
  },
  {
    "id": 406,
    "section": 4,
    "text": "Um ponto localiza-se à longitude -66°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 19",
      "Fuso 20",
      "Fuso 18",
      "Fuso 21"
    ],
    "answer": 1
  },
  {
    "id": 407,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 147°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 56",
      "Fuso 54",
      "Fuso 53",
      "Fuso 55"
    ],
    "answer": 3
  },
  {
    "id": 408,
    "section": 4,
    "text": "A longitude de um ponto é medida, por convenção internacional, a partir de:",
    "options": [
      "O meridiano de referência de Greenwich (longitude 0°).",
      "O centro geométrico do continente onde o ponto se localiza.",
      "O Pólo Norte geográfico.",
      "O Equador."
    ],
    "answer": 0
  },
  {
    "id": 409,
    "section": 4,
    "text": "As curvas de nível, numa carta topográfica, representam:",
    "options": [
      "Limites administrativos de municípios, independentemente do tipo e da marca de equipamento efectivamente utilizado.",
      "Estradas e caminhos existentes na área.",
      "A rede hidrográfica exclusivamente.",
      "Linhas que unem pontos de igual altitude, permitindo representar o relevo do terreno numa carta bidimensional."
    ],
    "answer": 3
  },
  {
    "id": 410,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:1000, a distância entre dois pontos, medida directamente sobre a carta, é de 28 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "2800.00 m",
      "280.00 m",
      "28.00 m",
      "140.00 m"
    ],
    "answer": 1
  },
  {
    "id": 411,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:25 000, a distância entre dois pontos, medida directamente sobre a carta, é de 27 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "6750.00 m",
      "675.00 m",
      "67500.00 m",
      "3375.00 m"
    ],
    "answer": 0
  },
  {
    "id": 412,
    "section": 4,
    "text": "Um ponto localiza-se à longitude 72°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 41",
      "Fuso 43",
      "Fuso 42",
      "Fuso 44"
    ],
    "answer": 1
  },
  {
    "id": 413,
    "section": 4,
    "text": "A escala gráfica de uma carta, em relação à escala numérica, tem como principal vantagem:",
    "options": [
      "Só poder ser usada em cartas digitais, sem que seja necessária qualquer verificação ou confirmação adicional posterior, conforme os manuais técnicos da área.",
      "Dispensar totalmente a necessidade de qualquer escala numérica.",
      "Ser sempre mais precisa do que a escala numérica.",
      "Manter-se válida mesmo que a carta seja ampliada ou reduzida (por fotocópia, por exemplo), ao contrário da escala numérica."
    ],
    "answer": 3
  },
  {
    "id": 414,
    "section": 4,
    "text": "Uma projecção conforme, como a UTM, caracteriza-se por:",
    "options": [
      "Não introduzir qualquer tipo de deformação, em nenhuma zona da carta, conforme estabelecido pelas normas técnicas convencionalmente seguidas no sector.",
      "Preservar os ângulos e a forma local dos objectos representados, à custa de deformações na escala/área em zonas mais afastadas da linha de referência.",
      "Preservar exactamente todas as áreas, sem qualquer deformação angular.",
      "Ser aplicável apenas a mapas de pequena escala do mundo inteiro."
    ],
    "answer": 1
  },
  {
    "id": 415,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:25 000, a distância entre dois pontos, medida directamente sobre a carta, é de 28 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "70000.00 m",
      "3500.00 m",
      "700.00 m",
      "7000.00 m"
    ],
    "answer": 3
  },
  {
    "id": 416,
    "section": 4,
    "text": "Um ponto localiza-se à longitude -59°. A que fuso UTM (numeração de 1 a 60, cada um com 6° de amplitude, iniciando em -180°) pertence este ponto?",
    "options": [
      "Fuso 19",
      "Fuso 20",
      "Fuso 22",
      "Fuso 21"
    ],
    "answer": 3
  },
  {
    "id": 417,
    "section": 4,
    "text": "A topologia, em SIG, refere-se a:",
    "options": [
      "A cor utilizada na representação dos elementos, sem que seja necessária qualquer verificação ou confirmação adicional posterior, independentemente da escala do levantamento.",
      "O sistema de coordenadas utilizado no projecto.",
      "A escala numérica de uma carta.",
      "As relações espaciais entre objectos geográficos (por exemplo, adjacência, conectividade), importantes para garantir a consistência dos dados vectoriais."
    ],
    "answer": 3
  },
  {
    "id": 418,
    "section": 4,
    "text": "O LiDAR (Light Detection and Ranging), enquanto tecnologia de levantamento, baseia-se em:",
    "options": [
      "Medir distâncias através da emissão e reflexão de pulsos laser, permitindo gerar nuvens de pontos tridimensionais de elevada densidade.",
      "Uma técnica exclusivamente baseada em fotografias convencionais.",
      "Um método de nivelamento geométrico clássico com mira e nível.",
      "Uma técnica que só pode ser aplicada em ambientes subaquáticos."
    ],
    "answer": 0
  },
  {
    "id": 419,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:1000, a distância entre dois pontos, medida directamente sobre a carta, é de 26 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "2600.00 m",
      "26.00 m",
      "130.00 m",
      "260.00 m"
    ],
    "answer": 3
  },
  {
    "id": 420,
    "section": 4,
    "text": "A convergência de meridianos, num sistema de projecção como o UTM, refere-se a:",
    "options": [
      "Ao ângulo entre o Norte verdadeiro e o Norte de quadrícula, num determinado ponto, resultante da diferença entre a direcção do meridiano local e o meridiano central do fuso.",
      "A diferença entre duas escalas cartográficas distintas.",
      "Não ter qualquer relação com a orientação de direcções num levantamento.",
      "A um erro instrumental do teodolito."
    ],
    "answer": 0
  },
  {
    "id": 421,
    "section": 4,
    "text": "A projecção UTM (Universal Transversa de Mercator) divide a Terra em:",
    "options": [
      "Fusos de 6° de longitude, cada um com o seu próprio meridiano central, minimizando as deformações dentro de cada fuso.",
      "Apenas dois hemisférios, sem qualquer subdivisão adicional.",
      "Faixas de latitude de 60° cada.",
      "Círculos concêntricos centrados no Equador, sendo esta a prática mais comummente adoptada em trabalhos de campo de rotina."
    ],
    "answer": 0
  },
  {
    "id": 422,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:2500, a distância entre dois pontos, medida directamente sobre a carta, é de 27 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "337.50 m",
      "6750.00 m",
      "67.50 m",
      "675.00 m"
    ],
    "answer": 3
  },
  {
    "id": 423,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:5000, a distância entre dois pontos, medida directamente sobre a carta, é de 25 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "1250.00 m",
      "12500.00 m",
      "625.00 m",
      "125.00 m"
    ],
    "answer": 0
  },
  {
    "id": 424,
    "section": 4,
    "text": "Numa carta topográfica à escala 1:2500, a distância entre dois pontos, medida directamente sobre a carta, é de 21 cm. Qual é a distância real correspondente no terreno?",
    "options": [
      "525.00 m",
      "5250.00 m",
      "262.50 m",
      "52.50 m"
    ],
    "answer": 0
  },
  {
    "id": 425,
    "section": 4,
    "text": "Curvas de nível muito próximas entre si, numa carta topográfica, indicam:",
    "options": [
      "Um terreno com declive acentuado (íngreme).",
      "Um terreno plano, sem qualquer declive, sendo esta a prática mais comum em campo.",
      "A presença de água na área representada.",
      "Um erro de impressão da carta."
    ],
    "answer": 0
  },
  {
    "id": 426,
    "section": 5,
    "text": "O armazenamento seguro de dados de campo e de projectos de clientes, incluindo protecção contra acesso não autorizado, é uma responsabilidade do topógrafo porque:",
    "options": [
      "É uma exigência sem qualquer fundamento ético ou prático.",
      "Contribui para a protecção da confidencialidade e da integridade da informação confiada pelos clientes.",
      "Aplica-se apenas a projectos de âmbito internacional.",
      "É uma responsabilidade exclusiva do departamento de informática da empresa contratante."
    ],
    "answer": 1
  },
  {
    "id": 427,
    "section": 5,
    "text": "A responsabilidade do topógrafo perante a segurança da sua equipa de campo (assistentes, porta-miras, operadores) reflecte-se, entre outros aspectos, em:",
    "options": [
      "Garantir condições de trabalho seguras, formação adequada e equipamento de protecção apropriado para as tarefas desempenhadas.",
      "Delegar toda a responsabilidade de segurança exclusivamente aos próprios assistentes de campo.",
      "Uma preocupação irrelevante para efeitos de ética profissional.",
      "Ignorar completamente as condições de trabalho a que a equipa está exposta."
    ],
    "answer": 0
  },
  {
    "id": 428,
    "section": 5,
    "text": "A reincidência de um associado em condutas contrárias ao código de ética da ATTA deve, em princípio, ser tratada:",
    "options": [
      "De forma exclusivamente informal, sem qualquer registo processual.",
      "Da mesma forma que uma primeira infracção, sem qualquer distinção.",
      "Com maior severidade, reflectindo a gravidade acrescida de uma conduta reiterada apesar de eventual sanção ou advertência anterior.",
      "Sem qualquer consequência adicional, uma vez que o associado já foi anteriormente sancionado."
    ],
    "answer": 2
  },
  {
    "id": 429,
    "section": 5,
    "text": "A protecção de dados pessoais e de informação cadastral sensível recolhida durante um levantamento é importante porque:",
    "options": [
      "Essa informação pode envolver dados de propriedade, identificação de proprietários ou outras informações privadas, cuja divulgação indevida pode causar danos a terceiros.",
      "Só é relevante em levantamentos realizados fora de Angola.",
      "Nunca existe qualquer informação sensível associada a um levantamento topográfico, conforme o entendimento partilhado por parte dos profissionais menos experientes na área.",
      "É uma preocupação exclusiva de empresas de tecnologia da informação."
    ],
    "answer": 0
  },
  {
    "id": 430,
    "section": 5,
    "text": "De acordo com o Estatuto da ATTA, compete à Associação, entre outras funções:",
    "options": [
      "Fiscalizar e promover a excelência e a ética no exercício da profissão de topógrafo em Angola.",
      "Substituir o papel dos tribunais em litígios de propriedade.",
      "Definir directamente os preços de mercado dos serviços de topografia.",
      "Não ter qualquer papel na admissão de novos associados."
    ],
    "answer": 0
  },
  {
    "id": 431,
    "section": 5,
    "text": "A minimização de danos ao terreno e à vegetação durante a materialização de pontos e a abertura de acessos para trabalhos de campo é importante porque:",
    "options": [
      "Aplica-se apenas a levantamentos realizados dentro de parques nacionais.",
      "Contribui para reduzir o impacto ambiental desnecessário da actividade profissional, especialmente em áreas ecologicamente sensíveis.",
      "O trabalho topográfico nunca provoca qualquer impacto físico no terreno, independentemente da posição hierárquica ou da experiência do profissional envolvido no caso.",
      "É uma exigência sem qualquer relevância prática para o resultado técnico do levantamento."
    ],
    "answer": 1
  },
  {
    "id": 432,
    "section": 5,
    "text": "Receber ofertas, comissões ou benefícios de fornecedores de equipamento em troca de recomendações não fundamentadas tecnicamente a clientes constitui:",
    "options": [
      "Uma prática irrelevante para efeitos de ética profissional.",
      "Uma obrigação profissional do topógrafo.",
      "Uma prática perfeitamente aceitável, desde que não seja mencionada ao cliente.",
      "Uma potencial violação dos princípios de integridade e imparcialidade profissional, especialmente se não for divulgada ao cliente."
    ],
    "answer": 3
  },
  {
    "id": 433,
    "section": 5,
    "text": "Antes de aceitar um trabalho, é boa prática profissional que o topógrafo avalie:",
    "options": [
      "Apenas se o cliente é uma entidade pública ou privada.",
      "Se possui a competência técnica, os recursos e o tempo necessários para realizar o trabalho com a qualidade exigida.",
      "Apenas o valor da remuneração oferecida, sem qualquer outra consideração.",
      "Exclusivamente a localização geográfica do trabalho."
    ],
    "answer": 1
  },
  {
    "id": 434,
    "section": 5,
    "text": "A denúncia, por parte de um colega, de uma conduta claramente antiética observada no exercício profissional de outro topógrafo:",
    "options": [
      "Só deve ocorrer se o denunciante obtiver benefício pessoal directo, independentemente da gravidade da situação ou do impacto sobre terceiros envolvidos.",
      "Constitui sempre um acto de deslealdade profissional que deve ser evitado.",
      "Pode ser um acto de responsabilidade profissional, na medida em que contribui para a protecção do interesse público e da credibilidade da profissão.",
      "É juridicamente proibida em qualquer circunstância."
    ],
    "answer": 2
  },
  {
    "id": 435,
    "section": 5,
    "text": "A elaboração de um contrato ou proposta clara, especificando o âmbito, prazo e custo de um trabalho topográfico, contribui para:",
    "options": [
      "Estabelecer expectativas claras entre as partes, reduzindo a probabilidade de conflitos ou mal-entendidos futuros.",
      "Aumentar artificialmente o preço do serviço prestado.",
      "Substituir totalmente a necessidade de qualquer rigor técnico no trabalho.",
      "Complicar desnecessariamente a relação entre topógrafo e cliente, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional."
    ],
    "answer": 0
  },
  {
    "id": 436,
    "section": 5,
    "text": "A supervisão adequada de técnicos menos experientes por parte de um topógrafo sénior, num projecto de maior complexidade, é importante porque:",
    "options": [
      "Substitui totalmente a necessidade de qualquer verificação de campo.",
      "É uma exigência sem qualquer benefício prático para o projecto, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Só é necessária em projectos financiados por entidades internacionais.",
      "Contribui para a qualidade técnica do trabalho e para a formação e desenvolvimento profissional dos técnicos mais jovens."
    ],
    "answer": 3
  },
  {
    "id": 437,
    "section": 5,
    "text": "A honestidade na apresentação de qualificações e experiência profissional, por parte de um topógrafo perante um cliente ou empregador, é um dever ético porque:",
    "options": [
      "Permite ao cliente confiar plenamente na competência declarada, evitando prejuízos decorrentes de uma falsa representação da capacidade técnica.",
      "É irrelevante, desde que o trabalho final seja entregue dentro do prazo.",
      "Pode ser dispensada sempre que o cliente não solicite expressamente essa informação.",
      "Só se aplica a topógrafos com mais de dez anos de experiência, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional."
    ],
    "answer": 0
  },
  {
    "id": 438,
    "section": 5,
    "text": "A assinatura (ou selo profissional) de um topógrafo num relatório, planta ou memória descritiva de um levantamento tem como principal significado:",
    "options": [
      "Uma mera formalidade estética, sem qualquer implicação técnica ou legal.",
      "A assunção formal de responsabilidade técnica pelo conteúdo e pela qualidade do trabalho apresentado.",
      "Uma exigência aplicável apenas a trabalhos realizados fora de Angola, sendo esta uma prática que alguns consideram comum em diversas associações profissionais.",
      "A garantia de que o trabalho foi o mais barato possível."
    ],
    "answer": 1
  },
  {
    "id": 439,
    "section": 5,
    "text": "Perante indícios de ocupação irregular de terrenos identificados durante um levantamento, a conduta profissionalmente correcta do topógrafo é:",
    "options": [
      "Alterar os limites observados para favorecer o cliente que contratou o serviço, conforme o entendimento partilhado por parte dos profissionais menos experientes na área.",
      "Registar com rigor técnico o que foi observado, comunicando a situação de forma clara e objectiva nos documentos do levantamento.",
      "Recusar-se sempre a realizar qualquer levantamento em terrenos com indícios de ocupação irregular.",
      "Ignorar completamente a situação, registando apenas o que o cliente solicitar."
    ],
    "answer": 1
  },
  {
    "id": 440,
    "section": 5,
    "text": "A verificação e o controlo de qualidade internos, antes da entrega de um trabalho ao cliente, contribuem para reduzir o risco de responsabilidade profissional porque:",
    "options": [
      "São exigidos apenas em projectos financiados por entidades internacionais.",
      "Não têm qualquer relação com a responsabilidade profissional do topógrafo.",
      "Aumentam artificialmente o custo do serviço, sem qualquer benefício técnico, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Ajudam a detectar e corrigir erros antes que estes causem prejuízo a terceiros ou comprometam a fiabilidade do trabalho entregue."
    ],
    "answer": 3
  },
  {
    "id": 441,
    "section": 5,
    "text": "A formação em primeiros socorros e procedimentos de emergência para equipas de campo em topografia é relevante porque:",
    "options": [
      "O trabalho de campo nunca apresenta qualquer risco à saúde ou integridade física dos técnicos.",
      "É uma exigência aplicável apenas a profissões da área da saúde.",
      "Substitui totalmente a necessidade de qualquer seguro de responsabilidade civil.",
      "Permite uma resposta mais adequada em caso de acidente ou emergência médica durante o trabalho de campo, muitas vezes em locais remotos."
    ],
    "answer": 3
  },
  {
    "id": 442,
    "section": 5,
    "text": "O topógrafo que participa em processos de regularização fundiária deve, de forma particular, ter em atenção:",
    "options": [
      "Nenhum aspecto especial, uma vez que estes processos não diferem de qualquer outro levantamento comum.",
      "Apenas os interesses económicos da entidade que financia o processo, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "O rigor técnico dos levantamentos, dado o impacto directo destes processos na segurança da posse e nos direitos de uso da terra das populações envolvidas.",
      "Exclusivamente a rapidez de execução, independentemente da qualidade técnica."
    ],
    "answer": 2
  },
  {
    "id": 443,
    "section": 5,
    "text": "A imparcialidade do topógrafo em contextos de litígio de terras é particularmente relevante em Angola porque:",
    "options": [
      "A imparcialidade só é relevante em países com sistemas jurídicos diferentes do angolano.",
      "É uma preocupação exclusivamente académica, sem aplicação prática.",
      "Os resultados técnicos podem influenciar directamente decisões sobre direitos de propriedade, com impacto significativo na vida das partes envolvidas.",
      "Os levantamentos topográficos nunca têm qualquer relação com processos de titulação ou resolução de disputas de terra."
    ],
    "answer": 2
  },
  {
    "id": 444,
    "section": 5,
    "text": "A cobrança de valores não previamente acordados com o cliente, sem qualquer justificação técnica documentada, constitui:",
    "options": [
      "Uma exigência normal em qualquer contrato de prestação de serviços.",
      "Uma questão irrelevante para efeitos deontológicos.",
      "Uma prática que pode comprometer a confiança e a relação profissional com o cliente, sendo eticamente questionável.",
      "Uma prática ética e profissionalmente correcta, sendo esta uma posição por vezes defendida em associações profissionais de outros países."
    ],
    "answer": 2
  },
  {
    "id": 445,
    "section": 5,
    "text": "Se um topógrafo for contratado simultaneamente por duas partes com interesses opostos numa mesma questão de limites de propriedade, a conduta mais adequada é:",
    "options": [
      "Aceitar ambos os contratos sem informar nenhuma das partes.",
      "Delegar a decisão exclusivamente ao Conselho de Direcção da ATTA, sem qualquer acção própria, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Favorecer a parte que oferecer melhor pagamento, sem qualquer comunicação.",
      "Divulgar claramente a situação a ambas as partes e, caso não seja possível actuar com imparcialidade, recusar um dos trabalhos ou retirar-se de um deles."
    ],
    "answer": 3
  },
  {
    "id": 446,
    "section": 5,
    "text": "O reconhecimento e valorização, pela ATTA, da experiência de técnicos seniores e percursores da topografia em Angola, formados fora de um percurso académico formal, é importante porque:",
    "options": [
      "A experiência prática nunca deve ser considerada, sendo apenas relevante a formação académica formal, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Essa experiência prática acumulada ao longo de anos de trabalho constitui um valor relevante para a profissão, complementando a formação académica formal.",
      "É uma prática sem qualquer fundamento técnico ou profissional.",
      "Estes técnicos não deveriam, em circunstância alguma, ser admitidos como associados da ATTA."
    ],
    "answer": 1
  },
  {
    "id": 447,
    "section": 5,
    "text": "Perante uma instrução do empregador que contraria claramente as boas práticas técnicas e pode comprometer a segurança de uma obra, o topógrafo deve:",
    "options": [
      "Cumprir sempre a instrução, independentemente das consequências técnicas.",
      "Abandonar imediatamente o local sem qualquer comunicação prévia, independentemente das eventuais consequências para a relação entre as partes envolvidas, independentemente das consequências para a relação profissional.",
      "Alertar formalmente para os riscos identificados e, se necessário, recusar-se a executar o trabalho de forma tecnicamente incorrecta, documentando a sua posição.",
      "Executar a instrução sem qualquer registo ou comunicação da sua discordância."
    ],
    "answer": 2
  },
  {
    "id": 448,
    "section": 5,
    "text": "A participação em acções de formação promovidas pela ATTA ou por outras entidades reconhecidas contribui para:",
    "options": [
      "Reforçar a qualidade técnica colectiva da profissão e a actualização dos seus membros face a novas normas, tecnologias e boas práticas.",
      "Reduzir artificialmente o número de associados activos na profissão.",
      "Nenhum benefício relevante para o exercício profissional.",
      "Substituir totalmente a experiência prática de campo."
    ],
    "answer": 0
  },
  {
    "id": 449,
    "section": 5,
    "text": "Um conflito de interesses, no exercício da profissão de topógrafo, ocorre tipicamente quando:",
    "options": [
      "O topógrafo trabalha em mais do que uma cidade ao longo da carreira.",
      "Duas empresas concorrentes utilizam o mesmo tipo de Estação Total.",
      "O topógrafo utiliza sempre o mesmo instrumento em diferentes trabalhos, independentemente das eventuais consequências para a relação entre as partes envolvidas.",
      "O topógrafo tem um interesse pessoal, financeiro ou familiar que pode comprometer, ou parecer comprometer, a sua objectividade e imparcialidade profissional."
    ],
    "answer": 3
  },
  {
    "id": 450,
    "section": 5,
    "text": "Um erro grosseiro num levantamento topográfico que resulte em prejuízo económico significativo para o cliente pode expor o topógrafo a:",
    "options": [
      "Nenhuma consequência, uma vez que os erros técnicos nunca têm implicações legais.",
      "Responsabilização civil, e eventualmente disciplinar perante a ATTA, consoante a gravidade e as circunstâncias do erro.",
      "Consequências exclusivamente informais, sem qualquer enquadramento legal.",
      "Uma sanção automática e universal, igual em qualquer país do mundo, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional."
    ],
    "answer": 1
  },
  {
    "id": 451,
    "section": 5,
    "text": "A subscrição de um seguro de responsabilidade civil profissional, por parte de um topógrafo ou empresa de topografia, tem como principal função:",
    "options": [
      "Ser proibida em qualquer jurisdição.",
      "Proteger financeiramente o profissional e assegurar a reparação de eventuais danos causados a terceiros por erros no exercício da actividade.",
      "Substituir totalmente a necessidade de qualquer rigor técnico no trabalho realizado, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Servir apenas como estratégia de marketing, sem qualquer utilidade prática."
    ],
    "answer": 1
  },
  {
    "id": 452,
    "section": 5,
    "text": "A alteração ou manipulação de dados de campo para satisfazer as expectativas de um cliente constitui:",
    "options": [
      "Uma prática recomendada quando o prazo do projecto é curto.",
      "Uma prática profissional aceitável em situações excepcionais.",
      "Uma grave violação da integridade técnica e ética profissional, com potenciais consequências legais e disciplinares.",
      "Uma decisão que cabe exclusivamente ao cliente, sem qualquer responsabilidade do topógrafo."
    ],
    "answer": 2
  },
  {
    "id": 453,
    "section": 5,
    "text": "O direito de defesa de um associado, num eventual processo disciplinar da ATTA, é importante porque:",
    "options": [
      "Deve ser sempre negado, para agilizar o processo disciplinar.",
      "Aplica-se apenas a associados fundadores da ATTA.",
      "Garante um processo justo e equitativo, permitindo ao associado apresentar a sua versão dos factos antes de qualquer decisão final.",
      "É uma formalidade sem qualquer relevância prática, conforme o entendimento partilhado por parte dos profissionais menos experientes na área."
    ],
    "answer": 2
  },
  {
    "id": 454,
    "section": 5,
    "text": "Perante condições climáticas ou de terreno claramente perigosas para a realização de um levantamento, a conduta profissionalmente responsável do topógrafo é:",
    "options": [
      "Delegar toda a decisão sobre segurança exclusivamente ao cliente.",
      "Prosseguir sempre o trabalho, independentemente do risco, para cumprir o prazo acordado, sendo esta uma posição partilhada por alguns profissionais da área.",
      "Avaliar o risco e, se necessário, adiar ou ajustar o trabalho, comunicando a decisão de forma clara ao cliente ou empregador.",
      "Ignorar completamente qualquer risco identificado no terreno."
    ],
    "answer": 2
  },
  {
    "id": 455,
    "section": 5,
    "text": "A Lei de Terras, no ordenamento jurídico angolano, regula, entre outras matérias:",
    "options": [
      "Apenas a construção de edifícios em zonas urbanas centrais, sendo esta uma posição por vezes defendida em associações profissionais de outros países.",
      "O regime jurídico da propriedade, uso e aproveitamento da terra em Angola, com implicações directas nos trabalhos de levantamento e cadastro.",
      "Exclusivamente questões relacionadas com o tráfego rodoviário.",
      "Matérias exclusivamente relacionadas com o direito marítimo."
    ],
    "answer": 1
  },
  {
    "id": 456,
    "section": 5,
    "text": "Assumir a responsabilidade técnica por um levantamento realizado com equipamento sabidamente descalibrado, sem informar o cliente dessa limitação, constitui:",
    "options": [
      "Uma questão irrelevante, uma vez que todos os equipamentos têm sempre algum erro, conforme o entendimento partilhado por parte dos profissionais menos experientes na área.",
      "Uma falha grave de integridade profissional, por comprometer a fiabilidade dos resultados sem conhecimento do cliente.",
      "Uma prática tecnicamente e eticamente aceitável, desde que o erro seja pequeno.",
      "Uma exigência normal do exercício da profissão."
    ],
    "answer": 1
  },
  {
    "id": 457,
    "section": 5,
    "text": "O uso responsável de drones em levantamentos, respeitando restrições de espaço aéreo e áreas sensíveis (como proximidade a aeroportos ou zonas protegidas), é importante porque:",
    "options": [
      "Existem riscos de segurança e regulamentações aplicáveis que devem ser respeitadas, protegendo pessoas, bens e áreas sensíveis.",
      "Não tem qualquer relação com a actividade profissional do topógrafo.",
      "É uma preocupação exclusiva de operadores de aviação comercial, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Drones podem ser operados livremente em qualquer local, sem qualquer restrição."
    ],
    "answer": 0
  },
  {
    "id": 458,
    "section": 5,
    "text": "As sanções disciplinares previstas no Estatuto de uma associação profissional, como a ATTA, têm como principal objectivo:",
    "options": [
      "Não têm qualquer função prática relevante.",
      "Punir arbitrariamente associados sem qualquer critério técnico ou ético.",
      "Gerar receita financeira adicional para a Associação.",
      "Corrigir condutas contrárias aos princípios éticos e técnicos da profissão, protegendo a credibilidade colectiva da Associação e da profissão."
    ],
    "answer": 3
  },
  {
    "id": 459,
    "section": 5,
    "text": "Perante um pedido de terceiros para aceder aos dados de um levantamento realizado para outro cliente, sem autorização deste, o topógrafo deve:",
    "options": [
      "Consultar apenas a opinião pessoal de colegas, sem qualquer outro critério.",
      "Recusar o pedido, salvo se existir consentimento do cliente original ou obrigação legal que determine a divulgação.",
      "Fornecer os dados de imediato, desde que seja pago um valor adicional.",
      "Fornecer apenas parte dos dados, sem qualquer critério definido, independentemente da gravidade da situação ou do impacto sobre terceiros envolvidos."
    ],
    "answer": 1
  },
  {
    "id": 460,
    "section": 5,
    "text": "A expropriação por utilidade pública, quando envolve trabalhos de levantamento topográfico para delimitação de áreas afectadas, exige do topógrafo:",
    "options": [
      "A recusa sistemática de participação em qualquer processo desta natureza.",
      "Nenhum cuidado adicional em relação a qualquer outro levantamento comum.",
      "A defesa automática dos interesses da entidade expropriante, independentemente dos dados técnicos, sendo esta uma prática que alguns consideram comum em diversas associações profissionais.",
      "Rigor técnico redobrado e clareza na comunicação dos resultados, dado o impacto directo nos direitos e indemnizações dos proprietários afectados."
    ],
    "answer": 3
  },
  {
    "id": 461,
    "section": 5,
    "text": "O princípio da integridade técnica, no exercício da profissão de topógrafo, implica:",
    "options": [
      "Priorizar sempre o lucro pessoal em detrimento da qualidade técnica do trabalho, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Realizar o trabalho com rigor científico e reportar fielmente os resultados obtidos, independentemente de pressões externas.",
      "Aceitar qualquer instrução do cliente, mesmo que tecnicamente incorrecta.",
      "Delegar toda a responsabilidade técnica no cliente."
    ],
    "answer": 1
  },
  {
    "id": 462,
    "section": 5,
    "text": "A integração de considerações de sustentabilidade nos projectos de topografia e cadastro (por exemplo, apoio ao ordenamento territorial responsável) reflecte:",
    "options": [
      "Uma tendência sem qualquer relevância para o futuro da profissão.",
      "Uma evolução importante do papel do topógrafo, contribuindo para um desenvolvimento territorial mais equilibrado e sustentável.",
      "Uma preocupação que compete exclusivamente a entidades governamentais, sem qualquer papel do topógrafo, independentemente da posição hierárquica do profissional envolvido.",
      "Uma exigência exclusivamente legal, sem qualquer dimensão ética."
    ],
    "answer": 1
  },
  {
    "id": 463,
    "section": 5,
    "text": "Perante uma denúncia fundamentada de conduta antiética por parte de um associado, cabe à ATTA:",
    "options": [
      "Transferir automaticamente a questão para as autoridades policiais, sem qualquer análise interna prévia, sendo esta uma posição partilhada por alguns profissionais da área.",
      "Aplicar imediatamente a sanção máxima, sem qualquer processo de averiguação.",
      "Analisar a denúncia através dos seus órgãos competentes, seguindo um processo justo e transparente antes de qualquer decisão disciplinar.",
      "Ignorar sistematicamente qualquer denúncia recebida."
    ],
    "answer": 2
  },
  {
    "id": 464,
    "section": 5,
    "text": "Assinar ou validar um trabalho técnico realizado inteiramente por outra pessoa, sem qualquer supervisão ou revisão efectiva por parte de quem assina, constitui:",
    "options": [
      "Uma exigência da legislação vigente, sem qualquer alternativa possível.",
      "Uma prática ética e profissionalmente aceitável em qualquer circunstância.",
      "Uma prática eticamente problemática, uma vez que a assinatura deve reflectir responsabilidade efectiva sobre o trabalho realizado.",
      "Uma prática irrelevante, desde que o cliente não seja informado, conforme o entendimento partilhado por parte dos profissionais menos experientes na área."
    ],
    "answer": 2
  },
  {
    "id": 465,
    "section": 5,
    "text": "Perante um levantamento cujos resultados possam ser usados para fins de litígio de propriedade, o topógrafo deve:",
    "options": [
      "Garantir rigor técnico, imparcialidade e reportar fielmente os resultados obtidos, independentemente de quem contratou o serviço.",
      "Recusar-se sempre a realizar o levantamento.",
      "Alterar os dados conforme a conveniência do cliente que contratou o serviço, independentemente da posição hierárquica ou da experiência do profissional envolvido no caso.",
      "Delegar toda a responsabilidade ao cliente."
    ],
    "answer": 0
  },
  {
    "id": 466,
    "section": 5,
    "text": "Perante a descoberta de um erro significativo num levantamento já entregue ao cliente, a conduta ética adequada do topógrafo é:",
    "options": [
      "Culpar exclusivamente um colega pelo erro, sem qualquer verificação.",
      "Comunicar prontamente o erro ao cliente e propor as correcções necessárias, minimizando os riscos decorrentes da informação incorrecta.",
      "Ignorar o erro, esperando que ninguém o detecte, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Destruir todos os registos do levantamento para evitar responsabilização."
    ],
    "answer": 1
  },
  {
    "id": 467,
    "section": 5,
    "text": "A aceitação de trabalhos remunerados de forma contingente ao resultado favorável de um litígio de propriedade (por exemplo, \"só recebo se o cliente ganhar a causa\") levanta preocupações éticas porque:",
    "options": [
      "Pode criar um incentivo financeiro para favorecer um resultado específico, comprometendo a objectividade técnica esperada do topógrafo.",
      "É exigida por lei em qualquer contrato de topografia.",
      "Não tem qualquer relação com a integridade do trabalho técnico.",
      "É sempre uma prática recomendada pela deontologia profissional, sendo esta uma posição por vezes defendida em associações profissionais de outros países."
    ],
    "answer": 0
  },
  {
    "id": 468,
    "section": 5,
    "text": "Omitir deliberadamente incertezas ou limitações metodológicas relevantes num relatório técnico, para tornar o trabalho aparentemente mais rigoroso do que na realidade é, constitui:",
    "options": [
      "Uma prática ética recomendável, para transmitir confiança ao cliente.",
      "Uma prática irrelevante, desde que os valores numéricos apresentados estejam correctos.",
      "Uma exigência do código de ética profissional, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Uma falta de honestidade profissional que pode induzir o cliente em erro sobre a fiabilidade real dos resultados."
    ],
    "answer": 3
  },
  {
    "id": 469,
    "section": 5,
    "text": "A recusa em assinar ou validar um relatório técnico com o qual o topógrafo tecnicamente discorda, mesmo sob pressão do empregador, reflecte:",
    "options": [
      "O exercício responsável da independência técnica e da integridade profissional, protegendo terceiros de informação potencialmente incorrecta.",
      "Uma decisão irrelevante do ponto de vista deontológico.",
      "Uma atitude antiética e prejudicial à profissão, sendo esta uma prática que alguns consideram comum em diversas associações profissionais, sendo esta uma posição partilhada por alguns profissionais da área.",
      "Uma prática proibida pelo Estatuto da ATTA."
    ],
    "answer": 0
  },
  {
    "id": 470,
    "section": 5,
    "text": "A mentoria de topógrafos mais experientes a técnicos em início de carreira contribui, do ponto de vista deontológico, para:",
    "options": [
      "Substituir totalmente a necessidade de qualquer formação técnica formal.",
      "Nenhum benefício relevante para a profissão como um todo, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Enfraquecer desnecessariamente a posição profissional dos técnicos seniores.",
      "A transmissão de boas práticas, conhecimento prático e valores éticos essenciais ao exercício responsável da profissão."
    ],
    "answer": 3
  },
  {
    "id": 471,
    "section": 5,
    "text": "Um código de ética profissional, como o que rege a actividade do topógrafo, tem como principal função:",
    "options": [
      "Substituir totalmente a legislação nacional aplicável.",
      "Impor exclusivamente obrigações financeiras aos profissionais, sendo esta uma posição por vezes defendida em associações profissionais de outros países.",
      "Estabelecer princípios de conduta que orientam a actuação profissional, protegendo o interesse público e a credibilidade da profissão.",
      "Servir apenas como documento decorativo, sem qualquer aplicação prática."
    ],
    "answer": 2
  },
  {
    "id": 472,
    "section": 5,
    "text": "O cadastro predial/territorial, enquanto sistema de registo de propriedades, tem como uma das suas funções principais:",
    "options": [
      "Servir apenas para fins estatísticos, sem qualquer relação com a propriedade da terra.",
      "Fornecer uma base de informação sistematizada sobre a localização, limites e características das parcelas de terra, apoiando a segurança jurídica da propriedade.",
      "Substituir totalmente a necessidade de qualquer levantamento topográfico futuro.",
      "Ser da exclusiva responsabilidade de entidades privadas, sem qualquer papel do Estado."
    ],
    "answer": 1
  },
  {
    "id": 473,
    "section": 5,
    "text": "Um topógrafo que também é proprietário de uma empresa de venda de equipamentos deve, ao recomendar equipamentos a um cliente de serviços de topografia:",
    "options": [
      "Nunca poder prestar qualquer tipo de recomendação de equipamento.",
      "Divulgar esse interesse comercial ao cliente e basear a recomendação em critérios técnicos objectivos, não apenas no benefício comercial próprio.",
      "Recomendar sempre os seus próprios produtos, independentemente da adequação técnica.",
      "Ocultar sempre essa relação comercial, por não ser relevante, independentemente da posição hierárquica ou da experiência do profissional envolvido no caso."
    ],
    "answer": 1
  },
  {
    "id": 474,
    "section": 5,
    "text": "A documentação adequada de todo o processo de um levantamento (metodologia, equipamentos, condições, resultados) é importante, do ponto de vista ético, porque:",
    "options": [
      "É apenas uma exigência burocrática sem qualquer relação com a ética profissional.",
      "Serve exclusivamente para efeitos de facturação ao cliente, conforme o entendimento comum entre profissionais menos experientes.",
      "Não tem qualquer utilidade após a entrega do relatório final.",
      "Permite a verificação, auditoria e responsabilização adequada do trabalho realizado."
    ],
    "answer": 3
  },
  {
    "id": 475,
    "section": 5,
    "text": "A associação de um topógrafo à ATTA pode trazer, entre outros benefícios:",
    "options": [
      "Reconhecimento profissional, acesso a uma rede de pares e a possibilidade de participação em iniciativas de formação e valorização da profissão.",
      "A garantia automática de contratos de trabalho, independentemente da competência técnica, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Nenhum benefício relevante para o exercício da profissão.",
      "A isenção total de qualquer responsabilidade profissional."
    ],
    "answer": 0
  },
  {
    "id": 476,
    "section": 5,
    "text": "A transparência na comunicação dos resultados de um levantamento, mesmo quando estes revelam limitações ou incertezas nos dados, é importante porque:",
    "options": [
      "É uma prática proibida pelo código de ética profissional, independentemente das eventuais consequências para a relação entre as partes envolvidas, sendo esta uma posição partilhada por alguns profissionais da área.",
      "Permite ao cliente e a outras partes interessadas compreender correctamente o alcance e as limitações dos resultados apresentados, evitando decisões baseadas em informação incompleta ou enganosa.",
      "Serve apenas para dificultar desnecessariamente o trabalho do topógrafo.",
      "Nunca deve ser feita, para não comprometer a reputação do topógrafo."
    ],
    "answer": 1
  },
  {
    "id": 477,
    "section": 5,
    "text": "A sinalização adequada de um local de trabalho de campo em zonas de tráfego (por exemplo, na berma de uma estrada) é importante porque:",
    "options": [
      "É uma exigência exclusivamente estética, sem qualquer função de segurança.",
      "Só é obrigatória em rodovias internacionais.",
      "Não tem qualquer relação com a segurança da equipa de topografia, sendo esta uma prática comum em diversas associações profissionais.",
      "Reduz o risco de acidentes envolvendo a equipa de trabalho e os utentes da via."
    ],
    "answer": 3
  },
  {
    "id": 478,
    "section": 5,
    "text": "A actuação como perito topógrafo num processo judicial exige, sobretudo:",
    "options": [
      "A omissão de quaisquer dados que possam ser desfavoráveis a qualquer das partes.",
      "Total alinhamento com os interesses da parte que solicitou o parecer.",
      "A recusa sistemática de qualquer trabalho pericial em contexto judicial, independentemente da gravidade da situação ou do impacto sobre terceiros envolvidos.",
      "Rigor técnico e imparcialidade, mesmo quando as conclusões não sejam favoráveis à parte que contratou o perito."
    ],
    "answer": 3
  },
  {
    "id": 479,
    "section": 5,
    "text": "Perante uma reclamação formal de um cliente relativa a um trabalho realizado, a conduta profissionalmente adequada do topógrafo é:",
    "options": [
      "Responder de forma agressiva, sem qualquer análise técnica da questão.",
      "Recusar qualquer comunicação directa com o cliente reclamante, conforme o entendimento partilhado por parte dos profissionais menos experientes na área.",
      "Analisar tecnicamente a reclamação com objectividade, esclarecer o cliente e, se aplicável, corrigir o erro identificado.",
      "Ignorar a reclamação, esperando que o cliente desista."
    ],
    "answer": 2
  },
  {
    "id": 480,
    "section": 5,
    "text": "Num levantamento realizado no contexto de um litígio judicial de limites de propriedade, a principal responsabilidade do topógrafo perante o tribunal é:",
    "options": [
      "Apresentar resultados tecnicamente rigorosos e imparciais, no interesse da correcta administração da justiça.",
      "Alterar os resultados conforme as instruções do advogado da parte contratante.",
      "Defender os interesses da parte que o contratou, independentemente dos resultados técnicos obtidos.",
      "Recusar-se sempre a colaborar em processos judiciais, conforme frequentemente discutido em contextos de formação e actualização deontológica."
    ],
    "answer": 0
  },
  {
    "id": 481,
    "section": 5,
    "text": "A competência técnica, enquanto princípio deontológico, exige que o topógrafo:",
    "options": [
      "Aceite qualquer trabalho, independentemente de possuir ou não a formação e experiência necessárias.",
      "Só aceite trabalhos para os quais possua a formação, experiência e meios técnicos adequados, ou que colabore com outros profissionais quando necessário.",
      "Delegue sempre todo o trabalho técnico a terceiros, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional, sendo esta uma posição partilhada por alguns profissionais da área.",
      "Nunca procure actualização ou formação contínua."
    ],
    "answer": 1
  },
  {
    "id": 482,
    "section": 5,
    "text": "A comunicação clara e atempada de eventuais atrasos ou dificuldades técnicas ao cliente, durante a execução de um projecto, é importante porque:",
    "options": [
      "Permite ao cliente ajustar as suas expectativas e tomar decisões informadas sobre o andamento do projecto.",
      "Prejudica sempre a reputação do topógrafo, devendo ser evitada, independentemente das eventuais consequências para a relação entre as partes envolvidas.",
      "Só é relevante em projectos de âmbito internacional.",
      "É uma prática desnecessária, desde que o trabalho seja entregue eventualmente."
    ],
    "answer": 0
  },
  {
    "id": 483,
    "section": 5,
    "text": "A criação de uma Comissão Técnica de Trabalho pela Direcção da ATTA, para organizar o processo de exame de admissão, demonstra sobretudo:",
    "options": [
      "Uma medida sem qualquer efeito prático nos processos internos da ATTA.",
      "Uma tentativa de centralizar todo o poder da Associação numa única pessoa, independentemente das eventuais consequências para a relação entre as partes envolvidas.",
      "A preocupação da Associação em assegurar transparência, imparcialidade e rigor técnico-científico no processo de admissão de novos associados.",
      "Uma exigência legal aplicável apenas a associações desportivas."
    ],
    "answer": 2
  },
  {
    "id": 484,
    "section": 5,
    "text": "Alterações significativas ao âmbito de um projecto de topografia, solicitadas pelo cliente após o início dos trabalhos, devem ser tratadas, do ponto de vista ético e profissional, através de:",
    "options": [
      "A duplicação do valor do contrato original, sem qualquer justificação técnica.",
      "Ignorar a alteração e continuar o trabalho conforme inicialmente planeado, sem qualquer comunicação.",
      "A recusa automática de qualquer alteração, independentemente da sua razoabilidade, conforme frequentemente discutido em contextos de formação e actualização deontológica.",
      "Uma comunicação clara com o cliente sobre as implicações técnicas, de prazo e de custo dessa alteração, formalizando-a adequadamente."
    ],
    "answer": 3
  },
  {
    "id": 485,
    "section": 5,
    "text": "A segurança no trabalho de campo, incluindo o uso de equipamento de protecção individual adequado, é uma responsabilidade do topógrafo porque:",
    "options": [
      "O trabalho de campo em topografia nunca envolve qualquer risco relevante para a segurança.",
      "O trabalho de campo pode envolver riscos (tráfego, terrenos acidentados, condições climáticas, entre outros) que devem ser geridos de forma responsável, protegendo a equipa e terceiros.",
      "É uma preocupação exclusiva do empregador, sem qualquer responsabilidade pessoal do topógrafo, independentemente das eventuais consequências para a relação entre as partes envolvidas, conforme o entendimento comum entre profissionais menos experientes.",
      "Aplica-se apenas a trabalhos realizados em minas ou pedreiras."
    ],
    "answer": 1
  },
  {
    "id": 486,
    "section": 5,
    "text": "A actuação profissional independente do topógrafo, face a pressões comerciais ou políticas, é um valor deontológico importante porque:",
    "options": [
      "Nunca deve ser exercida, devendo o topógrafo seguir sempre as instruções do cliente, mesmo quando tecnicamente incorrectas.",
      "É irrelevante para a qualidade do trabalho topográfico.",
      "Protege a objectividade técnica dos resultados apresentados, no interesse de todas as partes envolvidas e da sociedade em geral.",
      "Aplica-se apenas a topógrafos que trabalham no sector público."
    ],
    "answer": 2
  },
  {
    "id": 487,
    "section": 5,
    "text": "A responsabilidade civil profissional do topógrafo relaciona-se com:",
    "options": [
      "Uma questão irrelevante para o exercício da topografia.",
      "Uma responsabilidade exclusivamente penal, sem qualquer relação com indemnizações.",
      "A obrigação de reparar eventuais danos causados a terceiros em consequência de erros ou negligência no exercício da sua actividade profissional.",
      "Uma obrigação que nunca se aplica a profissionais liberais."
    ],
    "answer": 2
  },
  {
    "id": 488,
    "section": 5,
    "text": "Perante um associado que actue de forma manifestamente contrária ao código de ética da ATTA, é apropriado que a Associação:",
    "options": [
      "Analise o caso através dos seus órgãos competentes, podendo aplicar as medidas disciplinares previstas no seu Estatuto e regulamentos internos.",
      "Aplique automaticamente uma sanção penal, sem qualquer processo prévio.",
      "Transfira imediatamente o caso para um tribunal internacional, sendo esta uma posição por vezes defendida em associações profissionais de outros países.",
      "Ignore a situação, por não ter qualquer competência disciplinar."
    ],
    "answer": 0
  },
  {
    "id": 489,
    "section": 5,
    "text": "Se um topógrafo identificar que os limites de propriedade reivindicados por um cliente contrariam os elementos técnicos observados em campo, deve:",
    "options": [
      "Comunicar objectivamente ao cliente a discrepância encontrada, mantendo o rigor técnico dos dados registados.",
      "Ignorar a discrepância e entregar apenas o que o cliente deseja ouvir.",
      "Recusar-se a entregar qualquer relatório, sem qualquer explicação ao cliente.",
      "Alterar os elementos técnicos para corresponder à reivindicação do cliente."
    ],
    "answer": 0
  },
  {
    "id": 490,
    "section": 5,
    "text": "O topógrafo que identifica, durante um levantamento, sinais evidentes de degradação ambiental significativa (por exemplo, desmatamento ilegal) numa área de trabalho deve:",
    "options": [
      "Ignorar completamente a situação, por não fazer parte do âmbito contratado.",
      "Alterar os dados do levantamento para ocultar a situação observada.",
      "Registar objectivamente o que observou, no âmbito das suas competências, podendo comunicar a situação às entidades ou ao cliente conforme apropriado.",
      "Denunciar publicamente a situação nas redes sociais, sem qualquer verificação prévia."
    ],
    "answer": 2
  },
  {
    "id": 491,
    "section": 5,
    "text": "A actualização profissional contínua do topógrafo, face à evolução tecnológica (novos equipamentos, software, métodos), é importante porque:",
    "options": [
      "É uma exigência meramente burocrática, sem qualquer benefício prático.",
      "A profissão de topógrafo não sofre qualquer evolução tecnológica relevante ao longo do tempo.",
      "Só é relevante para topógrafos recém-formados, não para profissionais experientes.",
      "Permite manter a competência técnica necessária para prestar um serviço de qualidade, acompanhando a evolução das ferramentas e métodos da profissão."
    ],
    "answer": 3
  },
  {
    "id": 492,
    "section": 5,
    "text": "O dever de zelo profissional implica que o topógrafo:",
    "options": [
      "Aplique cuidado, atenção e diligência adequados em todas as fases do trabalho, desde o planeamento até à entrega dos resultados.",
      "Ignore normas técnicas quando estas dificultem a rapidez de execução.",
      "Delegue toda a responsabilidade pela qualidade do trabalho ao cliente.",
      "Execute o trabalho com a maior rapidez possível, independentemente da qualidade."
    ],
    "answer": 0
  },
  {
    "id": 493,
    "section": 5,
    "text": "O respeito pelas normas técnicas e regulamentares aplicáveis ao exercício da topografia (mesmo quando não fiscalizadas de forma sistemática) é importante porque:",
    "options": [
      "Aplica-se exclusivamente a obras públicas de grande dimensão.",
      "Só deve ser respeitado quando existe fiscalização directa no momento do trabalho, independentemente das eventuais consequências para a relação entre as partes envolvidas.",
      "Contribui para a qualidade, a segurança e a fiabilidade dos trabalhos realizados, protegendo terceiros e a sociedade em geral.",
      "É uma formalidade sem qualquer efeito prático nos resultados do levantamento."
    ],
    "answer": 2
  },
  {
    "id": 494,
    "section": 5,
    "text": "Servidões (por exemplo, de passagem ou de infraestruturas) identificadas durante um levantamento devem ser:",
    "options": [
      "Devidamente registadas e comunicadas, uma vez que podem condicionar o uso e aproveitamento da propriedade levantada.",
      "Da exclusiva responsabilidade do proprietário vizinho, sem qualquer relação com o levantamento.",
      "Sempre eliminadas do relatório final, para simplificar a apresentação ao cliente, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Ignoradas, por não terem qualquer relevância técnica ou legal."
    ],
    "answer": 0
  },
  {
    "id": 495,
    "section": 5,
    "text": "A divulgação pública de resultados de um levantamento, em publicações técnicas ou científicas, sem o consentimento do cliente proprietário dos dados, pode constituir:",
    "options": [
      "Uma prática irrelevante do ponto de vista ético, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional, independentemente das consequências para a relação profissional.",
      "Uma violação do dever de confidencialidade, salvo se os dados forem devidamente anonimizados ou exista autorização expressa para a divulgação.",
      "Uma prática sempre permitida, independentemente de qualquer autorização.",
      "Uma exigência obrigatória imposta pela ATTA a todos os seus associados."
    ],
    "answer": 1
  },
  {
    "id": 496,
    "section": 5,
    "text": "A exigência de exames de admissão para novos associados da ATTA justifica-se principalmente por:",
    "options": [
      "Garantir a qualidade técnica dos futuros associados e reforçar a credibilidade institucional da Associação perante a sociedade.",
      "Reduzir artificialmente o número de topógrafos activos em Angola, conforme sugerido por alguma literatura introdutória sobre ética e deontologia profissional.",
      "Exigência exclusivamente financeira, sem qualquer critério técnico.",
      "Uma formalidade sem qualquer relação com a qualidade da profissão."
    ],
    "answer": 0
  },
  {
    "id": 497,
    "section": 5,
    "text": "O sigilo profissional em topografia implica que o técnico:",
    "options": [
      "Pode partilhar livremente dados de clientes com terceiros sem autorização, independentemente da gravidade da situação ou do impacto sobre terceiros envolvidos, independentemente da gravidade da situação em causa.",
      "Só se aplica a levantamentos governamentais.",
      "Deve evitar conflitos de interesse e não divulgar informações confidenciais obtidas no exercício da profissão sem autorização do cliente, salvo obrigação legal.",
      "Não é uma responsabilidade deontológica do topógrafo."
    ],
    "answer": 2
  },
  {
    "id": 498,
    "section": 5,
    "text": "Um topógrafo que delega parte significativa do trabalho técnico a um estagiário sem qualquer supervisão, apresentando o resultado final como inteiramente seu, actua de forma:",
    "options": [
      "Ética, desde que o estagiário tenha assinado um contrato de trabalho.",
      "Irrelevante, uma vez que o resultado final é o mesmo, independentemente de quem o executou.",
      "Recomendada pela ATTA como forma de reduzir custos operacionais.",
      "Contrária aos princípios de honestidade e responsabilidade profissional, por não reflectir adequadamente a real autoria e supervisão do trabalho."
    ],
    "answer": 3
  },
  {
    "id": 499,
    "section": 5,
    "text": "Um topógrafo sénior, com décadas de experiência prática mas sem formação formal recente em tecnologias como GNSS RTK ou fotogrametria com drone, deve considerar:",
    "options": [
      "Delegar toda a responsabilidade tecnológica a técnicos mais jovens, sem qualquer supervisão.",
      "Que a sua experiência prática torna dispensável qualquer actualização tecnológica.",
      "Que estas tecnologias nunca deverão ser utilizadas em Angola.",
      "Investir na sua actualização técnica, de forma a poder aplicar de forma competente as novas ferramentas disponíveis na profissão."
    ],
    "answer": 3
  },
  {
    "id": 500,
    "section": 5,
    "text": "A consideração de impactos ambientais durante trabalhos de levantamento topográfico em áreas sensíveis (por exemplo, zonas de protecção ambiental) reflecte:",
    "options": [
      "Uma exigência exclusiva de projectos financiados por organizações internacionais.",
      "Uma questão que compete apenas a biólogos e engenheiros ambientais, sem qualquer relação com a topografia.",
      "Uma responsabilidade profissional crescente, alinhada com boas práticas de sustentabilidade e respeito pelo ambiente no exercício da actividade.",
      "Uma preocupação irrelevante para o exercício da topografia."
    ],
    "answer": 2
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
  const LOGO_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPcAAADACAYAAADY8/VGAAChrUlEQVR4nOz9d5Bl2X3fCX6Oue7Z9JmV5X11V3e1d+gGGgBJADQQPTWiDMmRWa40u7Gzq1nNSitppJmhJnZXMyFS0jJixRElkaInARCGRMN2ow3au/LeV/rnrz3n7B/3ZVZWdTXQlAihu5HfiBsvn8lnz/een/3+hHOODWxgA+8/yO/2G9jABjbwncEGuTewgfcpNsi9gQ28T7FB7g1s4H2KDXJvYAPvU2yQewMbeJ9ig9wb2MD7FBvk3sAG3qfYIPcGNvA+xQa5N7CB9yn0d/sNbOA/H9ZajDEIIZBSIoTAOYcQIMTao3A4nHM4ZwGQonzsjVDDS1Eebt3VDbynsEHu9zhWewNWSb1KbGtLAgsBSg0NNCcBS8nU9ax1bLD3/YcNcr/HYa1FSomU8obbrjcECW7wvpxAIEG44ba+nty3IPgG59+z2CD3+wDrTevVHVsptXb7KtGdWyV6eV2sEXqV/G7d5Qar3+vYIPd7HDfv2MaYt+zkRWGGRBfDS4dA4IYcfiuNV29xt7htA+8VbJD7PY71u3ZRFMCNhM+yDJAIRBlgk+v+x5WHWwu8rSewvfmVvgPvfgPfSWykwt4nKKPgbi2oBhDHAxYWFpy1Fju8f20vXr8pu5uuv/XZeSvZN/Buxwa53+MwxgAludeb40VRMD+/4K5cuUJJTIOjGAbSuCFN5ta72mtYb5rbdccG3ivYIPd7HNbatSDaenI75xgMBszNXSVJ+s66BCEM1uRlnluUjzHmJsKuEXyV3JYNk/y9iQ1yv8fhed7Qr74eIXfO4XkeExPjnD13imeefZI47TnPk/T6K24w6DqAOElZWW67t9Sx3IANYr9XsUHu9zGElKRpwjdfeIrBYInC9Vy9GVKt+aLIE5SC8clRMbTsN/A+wwa538eQQpDlCS+9/CxHjr7C0vJlhMsQQJL1XJoNnJSgvmXOZEMd972KDXK/71HQ6y/xxS99msXliyhZALELI4VW0B90rheqvQU3Vbdt4D2FjV/ufQi3LvwtpaPW8Hjl9Wc5fPQlVnpXgRgtBYiCbm/l+tb8tu71xu79XsQGud+HuKHTSzo83yBkzNef/CKvHXke42IgB5FTq0Y48m/3jDddbuC9gA1yv8/hXEGcdJmcanDk6Cs88/TXuHLtHLnroLSjVq2LwqTA20XVVk3zt7XdN/AuxQa53zN456bxmlkuwDlDlvfxfEulJnnz8Cs899LTdPsraCXIi75bawn9c3jtDbx7sEHudzXKyrLysLe4LLG++2u1BHV4A1I6ooqj01tmdtMo3d48Lzz/NPNXr6KEYhAPkGhwEme4Xm9uh3/jbnoPG1Vq7xVskPtdDQMU3EisVdZdv+55CiklRVGsKbIAGOsIQsWmTaMsLg0oigHjYyGnTr7J1578EoN0QLM+IeJ+AkaQxAZXlE9vM4PNy9d2rsCY7Kb3cPP7uQnuWxwb+C+CDXK/a/F2O6R7B48pIZzEWsPK0hzjo5CkbYxJERhOnzzOscOvA5KoGoGAQCvEcEUoT5UyDsYghESI633gG7v3ewMb5H5XY30w6+bbbj5uAemw1tFup4yOehhTRsWVFpw6fYznvvl14vjaUKfJgCyuv5QsKVxkDluAlD6lvtr64Jrkre9v3dvcwHcVG+R+12I9cfW6Q/FtSb0GNxRVcQR+iKc9lFIEgaY3WOG1N57n6LFXgIFDJCASsrSHHfaFC6FxRmFyUb62W31NxTtir3ibYwP/RbBB7nc1xJBQf1Z2XDefhRREYUC/F+MHIQiL0pZ6w2dh6SJff+rzXLn2BpA6qQvnSFxRDHDGIJVASA9rvD/j+17fQ7rhdH+3sEHudzXWyQu/I26sBtqGD3IOgSTwq7RaBUIo8izF2JTRsQjjejzzzSd47vknMHYBRIofgiN11pmhxS1xVr5DN/vmN7oacLtVQHAD32lskPs7gm8VKn6nB2/Pgbflxk13iPK6NeXuX+SGLE/JiwSpCjw/Z2nlPN984cscPv5NjF1GSINQBQi79hTi5o/0jj6z5a0kX3/bBr7T2CD3dwR/TuR+h/6pWHvNm15fOJyDNM0ZH2tS5LaUXRE5g7iFH1pGx31OnX2Drz35Odr9y8AAaxOcK3vEhQD5jn3lW5H75ss/wwfbwH8WNsj9HcGt1ENvhlubAHKrxznncHZ9pZm7rkd+EzesKwA7lE5yuDUbWpRKLcZRqdSHAwoEQlrSLEZpw+hYhTjp8Nobz3L4yMsk2TJC5lgTO2yB1CD1sKhl/UdbfY9ufYHLt9uVN3bs/5LYIPd3BDfvWG89HBbnDMbmGFvgMDhn1i6NzRnEfQpTRq7zoiBJ07Xr4DA2ByxplmBsgdISIcVQV80hKbXUoihiaWkZqQRSCUxh0B5Yl9IftGiOKNKsw+e+8Aecu3iUIPBwLidJek4oQEGauOsii678XNYWFCbD2mHlyw2ffxUbtenfLWxIG/+5452VaIqhhrhQJRnz/Hpn1mqF2SDuusKk+L4vAHzfQ2sJGKw19Hpd12w0hBDr/OJ1cOULleKJt9JSEiAV5Kmh1+tQieY4deYo27ccJPAnaK2skCXWBUFTZEXqPOuJwuZr71EIsTaqyNgCgbhBVvktL3bD5Qa+09gg93cM39oEdZSDAQSglcJJiXW2HOYnypleE+MjQgyDYoUpcCTOYQUIsiJ1ZaumBawDd1NYHW4kkuPtiOUEpKnj8uXzvPDC0+zacTsH9jzM2MQIzgVCCPCdL4QwKAQWO3zv5W7ssORFjrMQBtFNr+W4dSHOBr7T2CD3dwTrB+3d+v40TVBKobW3tosrIYaeuMVhyIvYpekA6wxaa4IgQFDayaGvhKcrvCN/V6zeL9aFv0s4B56n2L69yfxcizcPv8rM9BeZndrBSHOUPG+7LGsRRlW08gU4nDU4YVCiLKgRgJIC95bdWfCOC1428OeODZ/7O4JbpYNujCR7WqOURAyvW1dQmBxjSh8cDE5k6CCnEilqkY8nfSB3cbriCps6JVX5uLcQ/BYzwMSt3YXV+FwYKGq1Cu12m1defZEjJ14BlvF9R1QpECQk2YrLTN9ZUufIXW5TlxeJMzZHKYHWiusnmGEl3a0Mig38F8HGzv0dw7dezau+qrUGY02ZcpIKwWqTRkGoI8ADCgo3YH7hPKfOnKG13GHz7Fb27b3N1atNhFgtFBHDMBrcaBavnmhWr6/+WY4YKgrL1WsdqtUKtXrE8vIcz7/4DaqVGtu37aFZn0BQRSqHWLdkLA4rHULI8pnE+h1b3Prjv713sIE/Z2yQ+7sI6+xa9FspDyk04MiLnKLouWtzJ2n35llcXmBpaZkzZ85x/NgpgqDCRx7/KLv37GE1n81wrJ+g3CxvhGNNaeUGwpVes7OWJEkZHRlldCxgZanHCy88w7Wrc2ye3c7U1Czbth9g765DeDoiCCICP0IKr8yBI9Ztz++k5n0D/yWwQe5viXdqR95qK1qf+rk5sDX0rF25Y3vaA3wgY37xmjt9+iRXrp3j6IlvcvnKaVorKxjj6PViVpa7bN68DSEcI7XG+tcTbv1LDD1ggcDactSQEKrMlVvKMDkSZx1SSKrVYUunK7vGWu1FVlaWOXz4NTyvwsjIDHt2301zZIzt23exd88+tm3ZSeSPDF8yc8ZJtFDiLWmvW32N/0m7980ptg18K2yQ+y1YtRvXm7LfDqv+bfm/1oJzEikEQpaRYmfL0T1SOKSWYDO0lKVb6jpuYekyp84c5bU3XubM6WMsrixgih4Ly3P4yqPRHEPrECksY+N1JidGAUmexRRFQaAjJ8uNGDksKRPCIZygWm3S7w2oVBW1SoMkHZCkCUoGKCnJ0gTP8+l0OgRBRK0WEoal6IO1ApMnzM0d5/kXX2LL1hl2bd/Flu072LNzLwduu5Od2/a4ejSOFhGQ4FBgPYTQ4MSaqov4Fpu6c0P/fzWtdwN3b45Z3BxT2MCtsEHuG7DeL73ZZ775+vrdaf3tkjy1WCsIfIVwQ2IXjiQzztNCBKqMMBf5wHX71zh++hWefOoLPPvcl7g6v8DEuGTT5lmqNZ/cCnwd4HmO2CRYE1OvhhzYtwfIiZMe4F0fwWsNxhiUB1k6QDhoVCe4enUOicemqWkEXfrdeVRYpRKF5NkKWnn00y6joxFpmtDvrBCGIUHgY11GbUSyJwyp1qDdOceZp17ma1+17Ny5jw8+9lE+8MDjzE7vwfPrTqkqzgZYIiGMxlhZmu/GYYVDehLrrn+DzoEx5aWSpVEh1n/NbykKgutR+I0d/O0grmtcb+CW9d03EHd9Deat8rbl1pQNcrSnkJ4kG2QkceaCyBNBJcDZlCxtO6lyXnz5KT7/J7/Pq689Q+G6jIyFVCqawsSkaUq/nzAxMcOZU8soqdm2dStZKrnrzgf4e3/3l2h3VvC9JlmakyYFSZKSZQXzcwt0uz3A8MSXP81Tz36aA7dvI05iLl++RLUaMTU1iaMgCDwmp8a5dvUSRZHjKEizBEdBGAZ4ngfOUalWaDSavPDCEbpd2L9visnJUS5evMbCXJtNM1t49JGP8uEP/SD7992DViPYQpPGkiCsCR149FqpS5KC8cmqMMN6VmfFcBihxPMEajXg/haPZlXgbbUabrW/fYPcb4cNct+Amxsc1t++HjcTez25WQ1cY4ucNO07qS1B5Anou2tz53jz8Ms88aXPcnXuAnHSwfOgOVLH9zX9QY/l5SX6/R5hGLB3zwGWltqYAkZHplle6lOrjvMjP/QTPPvMizz//CvMXV1iMEgpCkOtViPPc/I8JwyrHDtxnloDghCCYFiRlkOSlqUvgQ+1GkxNS3bs2EZU0VQqEVJKlpeX6fW6RJUQrR39wQqjY6NEUUQSJ/R6A/LcIoUHaIpMUKuM8/DDj/Ohxz7OgX2H8LwxsFIgfBA+t2BtuWvbYZOKhLcU0wl4a1fZn0E04nsUG+Rew9sR++1wK5NwOD63MGRpjPIc2nMgjMvNNV546SleePFJzp47wdVr5zE2Q2uNUhpjIM8sWgWMjk4yOtrgwsVzpGlMGIScOtnixPE2nRZEEezfN0bgN7j3noeYmtxEFNWI45iJiUmmpqbwPI88zzhy9HUefOhuBnGLIPSRUnDp0kXOnD3DwsI8165e4dyF0ywvlVH7uQWoVOCeuyfYNFtDe175/uwAqRPyfECapQgElUqNarUOSPq9mCy1KBWSDAo2b97NRz70A3z48Y8zNroVMMRJASLC13UhpDcsiVVrX3/ZwVZG9cNI3SJ+tp7gGwUy3w4b5F7DarroWyVi19++rkDkhvsdmAzrMqQWQOZWOkd54it/yJe+/FkuX71MEGZMTjVJkphuJ0EQUY3G0bJGEkO3k5GmCSutaxw7XjAxDlEI+/ffxcd+4IfZtnUHvufRbIyT5Za9u/ehtc/58xeoVquMjo7S6/VYXl7m6NHDzGya5uDBA8zPz3PmzGl27NjKbbcfoNNpc+nyecCxtLRMksYcPnyKN994lSNHX+To0QEIOHSowa49Ewjdw/PKUcHGFuR5MZwNXlbYSamG6TyFKSSeDti1cz+PPvohHnjgQUaqWzCFT1r4CBGVXW9OijCsIGUZ/snSsvMtCNXbGEzrXaaNgNq3wga513BzwOZWtuHN6a1b+eYGyIHCDeJLvHH4mzz7/Bd55bWvs7h8DaEgjEqCgEHLgNAfQ7oarWXLpQstrl1ZYTCw7N47zsE77uP+++5kz55dzM5upbXS5dzZy+zcsZ9qtcapU2cYG51gfn6REydOMjY2ihCCkydPYowh8EM+/OHvY25+nq9+9SvMz81x3/33sG/fXgqTs3nzLHcdOsThI29w7vxphLBMTU7g+T4XLy7y9Se/zlNPPcHics723bB3b5PpmXEG/YRWp4XvKeqNOlpLVlbaLC932bFjE2EQMj+/xPJyly2bN/OJT3yMH/7hn2AkuguoYK0W1jqXFQVK+sL3IoQoLRisQ+m3OcFubNTvGBvkXsPqzr1K7vW7wvq0y/rVtd6MXyV6DnTdcus0Tz39BF/80mc4ceo1oopjarqBUDntdp96vYmUgjQ2LMzB+TMxSwsFo82Auw89wsGDB3no4bu5/eBu2u0erVaPKKxy5MgxvvbVJ6lWm1y5coVKpcboyBjnz1/g0qVL7N+/H9/3OXz4TWq1OocO3cPP/qWf4x//o3/CM88+zYH9BxgfH+XS5YvUGzV+6qd+ig9/+HHmrl3l3/za/49arcLtt9/GnXfeyaG7DtLrdXjuuec5fvIIz7/0BJeuXKTbhdlZxe49UzQadbIsI80GaK1QWrOyMofDp1bVIGDQ71Ov19i15wAfePiTfPTRv4SWDUBhnSUvQMtAKBVgrQS3ms77Ftgg+bfFRirsLVhPVsFbd+z1j1ufB1+dtVXh9Tc/xzPf/BzPv/gU5y+cIQw1zZEm1kpsAdVoDInH/NWU82e79LowNjLLfXffwYP338Pddz3Etm3bmF+4wtEjFzh/7jxPPPFlBoOYzZu30m4POHPmAnGcEkUVNs9uZuvWLVhr2LdvL7OzszSbZYHLnt27ybKc2267nU2bNrF792463TZKa0ZHR5iZ3kS1UmPfvtu4dm2eWq3K4sIyTzzxFT784Q/x6KOPcuedd/H4hx/hA48e4vU3Xua5585w+fJLvPHaMo16zOSUR3OkQiUKEbLAWiiKDFGXNJsVtFewvLTCV7/2LKdOXaHbEtx7z4fYuWU3UmiUdliXOemEEMIDob59780Gvi02du41rO7cw1D32m79VnJbWyBEqXySF7HLspRqpS7AcPL0i+4//Mf/F6+8/jWkMoyNjqOUR6fTwxqBFB7GSk6duEK3A5MTs9x16DYe/cAjHNh/CClDVpZbLC4u8du//bsUheHAgf2cPHmKa9eucfvttzO7eTNKSnbt2sXCwgL33Xcvvhdy5coVtm7bxtTkJJcvX6bdbrOy0mHz5p1MTkwR+AGdbpt2u0WSJGitGBsbY2xshH6/z6/8y19m27ZtXLp0gZdeeonZzbPMTE/Tare47ba9/NAPf4yxsSZKG37rt/4jzzxzjJOn30DKmD37tjE2LukP2oyN1zE2Jk1j+nGPej0kijTGCpI4QjPD/fc/zvf/wMc5uOdOBAG5AyVCJKGwTuKcHHadXS9uuf79lz/H27aObwDYIPc63ExuedPlKiyDuIcQxkWhL/px2y0vzzM62uTchdP8T//s75EXZ+n2V5iaGmNmaoarV1rMz/WYGNvCoOd45eWjROEYe3bt4oMfeozdu/dSrdU4e/Ykf/iHv0cQBGzespWTx8+xaWYru3fvZtOmTYw0m4yOj7Jpdpp6rU5R5ARByMrKEmEYlRVlzlHkOb7vkyYpX/7y13j44Q9QiWoEgV+2kzpbNqkIQZqlJHFMnmdkWcqmTZt4/Y3XeP3114jjmFOnTnPkyGHGxyfZsnkrYRjxwQ8+xl1338n2HdN87nN/yL/+//42l65cYu8+n63btjI2EdBqL1CYhCTpMz4xQqUiyYocU1TodxWDgeXeex/kL/7MX+a23XehREhuJFKGOKuFMZLAr4AbkpnrZC7y8ifRf1bF5e8xbJB7DbeKlq9L1Qwfk+cxaT5wWTEgCjRRUGWlfYnPfOEP+PznP4uTPUZG+qTZAouLMbYIGB/ZjC3qnDh6iaWFlJ3bD/ALP/+LVCt1vvb1r/DkU1/hwx99lJ07t/DP/9d/xs5dW/jkj/woggrTU1vYsmUrtVoVpSSep1BakCQpvV6HMAxIkhTf97HWopTGWocQkjRNeOaZZ3j4oUeIogg/0FhnMYVZU1IpigLPk2zbtp1XXnmFyclJNm/ezGDQ5/nnn+eLX/wivV6fbVt3c+zoWdqtDs888wL//H/7JRrNiNsO7MMP4Xd/79/xuc9/kaXlDnfeNcnk5BjNER9LzJmzF5CyIKxIBoOCWnWSkZEpOu0Bm2e381f+yl/n7oMPkcSu9NWjMbF+EIMxYE1J7rU8+IbP/W2xQe41rPrQN1ehrZL7uv5Zt7/knMhpVKr0+vN8/kuf4TN//HvMzV2hOeaRpleZnq4RBU0GPU2vIzl/us2l820e+8An+Pt//39kfHSaIAh5883X+Cf/9B8wNh7x137hL/L6m99kfLzOXXfdQ+iPU4ma+L5PlqXkRbrWN51lKXEc43keSZIQBD7GWJTyho0iiiROeebZb/DQQ/cTVYKylNS6tWGBZe24oSgySgGJlFqtRrPZREpJt9ul3W7heQGernH86AUunL9CvV7nD/7w97h27Qp+oPjZn/1p/trP/SVeeuU5fvVXf5ljx99kbgF+5i8+QJws0uu1GR2v4wWKldYKeZ5Tb4yQJo52q8+e3bfz8z//izxwx+PkBeRGEAUjwlqNEAopfJyFIi9rVrUWazPNNvD22CD3Gm4m91vN8VJUIcO53Ckp6Q0u85kv/D5/8Ie/SVb0mJ4epzdoEfqGTmsZpSoMevDS88vUokn+h3/0P/AD3/cT/O//5jepVZvceeedPP7hh8S//fVfc1/7+p/w137hp7nnvttoteZJkhStmkgC0jSn329TmJQwDIiiEIchy1I8T5MmOZ7vlx1eUg/JrYfkfor7H7iLShTg+R7OOYrCIGWpd2aMJctSkiRl9+5dpGnK5cuX6Xa7jI+Ps3PnTrT2mb/WxpmIK1fmmZyY5O//g/+eS5cucuiuO8mymHZ3iR/8oe/nscce5HOf/yM+/4U/5sWXFvnLf+VhmqOWM2dPoT1ojlUZJC3yPKfZGKffL1ha7PDoIx/lF37+v2HX7B1k1iGJyHOBlqHwvIiygw3yvHS4tSc2fO5vg41o+RpuLo64VXRccOXaRTczNY4j50++9Bn+5E//COUVNKoeK+3LVKpVQr9JfXaCp752nmNH2/zA9x/g7/wf/wGbprfz6U//Hl/52ufBapRXcM99e90HP/QQYaVASUm306fT7lEYR5EtI4WPVOVijip1wtADYej3YwZxjwo1sjxBSIcxDqUszpYdYUWRkw19aaUdTphhk0axtnMbYzCFIQh8er0uSZLSaNSJoojBYMCpUyfx/ZA0cVTCMTZvmUErxff/wEf51Kc+xaZNm5ibu8ryimV2ZgvHjp1mfHwTP/fX/jqVyu/x1JMvc/+De5mZ2sLc4lUGgz61pken22dxZY6JsUmmpnbxxuGX+Cf/9P/B3/nbf5cHD/2ocG7ghKewbjU9KRGyTJGtlqtu1LB8a2yQew2rK+VWbZ6rtxlmJidpdxd48pk/5fN/+ilW2nNMzzQobMYgjfG8CkUGzz15hrm5Pr/4t36Sn/npn+T48XP83u/8PvX6CPsPbObJJ59m5+4JFpYukBcxH3z8YVqtZU6fOkOlEhJVqri1VQxCSKR0WFfgbI51OUI4jM0oTIYqZBl4cmXL6arCiilW4whuWOI51D53AjFsDXUOkiTh0qU+vu8zOTlJvR7g3CKdTgeQjIyMI4Tm4qXTbNo0y333383+A3vwtCZJEzqdNocPH+OPP/tHKOX423/nb/H4hx7hjX/9m7z+6mHuvHMnjfooKuxj7ApOlPLOxsUUpkunu8i1K0t89rN/xPjYtNu95WGhROGkA2tzrDNI4aG0LLvGNnzub4uNc98NuDmvfeMKcs6i9YR45bUX+Y3f+HWuXr1Ioxmw3LpKlneYnqnR6a3wlS8fZdCr8vCDH2DXzr28/voxfuu3/gPPPf9VhO5QaaR0BhdJiqssLJ/k8tUTZFkPJQXWCCrhCMJ5NJtNKtUQcCTJgHZnmXZ7kf6gi5Ru2ODhUIqhmV2a2tcPhZIarX209oaXNx3Kx/MCarU69XqT6ZlZkiTjypWrIBSNRtk3LpWgWvVAJMzNXWDTpjEO3XUbjWaVvXt3cffddxHHMWUpquL0mTP8/u99mZ//uZ8iCKb5/d8/y/lzi3heQZbHFBbGJj2M7XPk2AV83+fQ3Qd47fWX+dVf/VdcXTzueoP20MKAvMiGI4jdrZtLNvAWbOzcb8GtfO2y1VCICsdOft198UufZaV1jXpTIWQ5XMA5SRwnvPjNPnFH8t/8H36BZqPG17/6Jbq9JRrNGmne4PiJ1wgjn8Lm/PK//CV+4Rf+JnccvIcr1y7hrE9zbJLcaKSEQVwuaAdofyh+wHCAgQWh3FAnfLW2u9yNhS1lh50ro+bWlvPCrBI4K3CmZIelFGOwVuBpj8ykjI2M0W51WVlus3VbA8/zWFwYkGUZWbbA9Mw4/d6AOOnQjzsgCpaXF1Ba8/GPfz979u5gEHf5zd/4d0zPzBAGPofuvJPAr3H1ylWSYpn7Hqniuik2N+SFZaRZZWx0DKUsadbl9Tde5Pd+/z/wQ5/4SfbsGEcIi5LXSe3ssC9sY2v6ltj4em5AadKa3GJyM/T3DMb2HKTu2vwz7lf+1T/kyPGvMTUj8fyEJO4T+U0CPc2TX+wSMMV/93/77/mJH/8Jjh45w4vffJWx5gSz01tIeylLcyucOXGOew/tQ8uQanWU2S07cTqkXwBBnb5VpMKnHRviDJwM8cMGUXWEIBpBqhrGBmSZJIkdUgRYq8lyMMZhrENISRAGGGtxRuGMD0U5jtfkEpMLbCEQVuGMpNfu0+v0aS238ZRmbGQUTylMkRP4HkI4VlrLIAyNkRqt9jJZNqA5UgGRURQxe/bu4IOPPcxHPvw4t+0/wA/94If53Ge/yI5t0/w//8Hf5sH7HubaxYAzJxwVv8ag7ZP2Nft2b0EruHz5HI2GoDFS8PSzf8SXvvZbFPaigxXne4UTwmILhy2nJ73DCrZb9eh/b2Bj514HZx0mLxcQrkDYHO0VztoWabrEr/2H/4Xzl5+jUhNoX2ESi69HoWhw+nTG4qUG/+yX/k/8zE/9FYrCsbS4yN5d+3no3od4/oVnac8PuP+Be7h0+SI/+zN/nfsffAgdVJmb7+FklaCmSIWCasBKr0M9qqExWGuJU4NI3VDf1EfgI4TF2IxaNcIiSLMexkosBk85tNYMkgQtQzwZ4UkfYfJyhIG1CCFRUoCWCGup1WsMej20FjTqVQa9Lg5LFHgURUpUqzJIE5yN8fzSasnzAeNjdeI45sLZk/i+T6VW45f+5/+ZX/93/579ew7SbRmee/o4t+3fg6fgDz79Fe57yGfX9m0st5forFiWllYYaUYEIfR6bfLc8vVv/BZ790zy4cd+DMU0znmYNECrcn7Zt2yzL39RyrPArYQ13v/YIPc65LFBeRIvUpjckpvEZbaL8jL++Au/w7Vrp6nWPOoNjyAIWEx6YDWSJi8//wp/62/8LLcfuI/P/fGf8tgHH+Uf/+N/wOWL57AmI036dFeWaS+1+eQPfpKH7r2fKAxZbrdot7tkhSOo1fG1IclSKGKEMghhEMOBgMPwF2KYvhTC0axXy9lfWqKVxJgCB6R5RrfTJU0S8jzFeJpCOIwthqa+QxhREh1b+u+eQgnITU6axCRZjDEFcSzRgUdUq+CEwuQFRVFgbDmLzOQ5SX+AsTlxXHDl8iWmpjfx0z/xU3zg4Uf5lX/5r/nUZ57mJ378cf6rn/0R+vEyX/rK60yObaIajRP3c3ztE/gaIVL6g5ggCNmyZZzf/t1fZ9+eO9gy00CpJsIT1zOW78ju/N4h883YIPc6SKVZFfeS2qJEgRUpl6+d5ItPfI5+PM/KSooxMD01hhKSV166RNyb5xd/8Uf4G3/9v+Z/+aV/wdPPPMfPXfk5PvnDP8im2RnSpMf+/Xt55cVv8sLzL/DjP/YJOktXSfo+TirGKgrjILd9iu6Aqh8y2tS4IkE6i5CuHBTiBE44ygEDAqwgbi/S6rQJqjUKW873DKMqYRgyiGMmpsdRvkMGBukVYC1SWHAWpTVSlWOMcpNCLsAZ4iSh1+uVgwjzDCEEnu8TxvVStbUwFEWBFhI/8ABHMohJkxSJJM9zLl24yKAXU6/XueeuQyzMzbF/7w4e+8Bj7Ng1Q6//9/nMp4/ys3/5bipVuHxliSSReL5DSdDKsrCwxNJCzO/87m/zN35uOyPNcSc9I0yuMZZSkulb4nu7lG2D3KtwoENYme84qR3NsUB4StHttfjt3/11rl47x8hojX17d3HlyhznziyjZQ1fK0Znx/jIRz7G8eNHefPwS2zZtpnGSB0noDk6gq9HGPSXGMQDWi1JkcdUAoHvOYQwBJGHE4Jur8cgTQio0Kw1yXoJwrqhGHnpMwrACVGqimrF9OgIlQBUVAHl009yDLKc/5UX+KEH2iBljlTghEWqvAy2aUBIlAAVeFgcWEFmFcpXaOPBMAKvtCYviuvvRQikUnjaL4N6tlQ5lU4wMzNDa3mFixfPMzU1xSd/+BN84mPfj8MwPz9Hq9XjkUc+wJkzv8OrL7/KvfcfIvDrZGlMXuRUKiGeF3D1SofNm6Z5+umnuOfQh/jQYzOla0H52t/DvH1H2CD3TRBCILBAgbFLvHr4KZ56+nNU6yF+oMkyR6O2iZU04cgbFwiDJh95/ON85Stf5aWXXmDH7s0cuusRtu7YSj/pw3KGFgWnTp1gce4iO7eA51JmJuq0luY5feIY/X4bP/RRSpJmMcZYtNZINPImoZdSklxihAQ0OqrSSwsqjVE2bd+DH1QZJDlJYonTlNwUFEVMVuQgA3JjyPMM5yCzGinKqLpDDEPRjiRLSfOUrMjXIu4Oh7UGgSzdAlfOBrNCIoUa5uElzlja7TaVSoUdO7Yy6PdprSwyOtIkzXI+9Uef47f/4He45767+JVf/hf85E/9XYQ8zl337AChiZMCL/RBFIShJU0TqrUav/O7v8HO7QfZtbPpkPIWSop/Vtwsk/z+wwa5VyEgHzgq1bqQXh/ouItXD/OHn/r3JFnGtu0TdLox/a6jFm1i/mqL0JviBz/+SWZntvBbv/0bvP7mGf7G33yAhx95gC1bdxH3exRFSr0WsmvHNj78+AeIPIvLB/ybf/UvuHLhFPNXlzBZQaUi8bSiyBmSu5wCenPQyAmwCMyq6+lp/GqToDHGRz/+SfbfeV/5YYTCDwJMuZ0ilMFJgzUFhStJK63BCU2eF3R6XdRwKKExljTNyPMCKQRSurJgpjBIobDOYY0tJZakRAlBMoixxqKl4sKFC0xNjrNj23a67RZnz5wknplCa8XSwjztVsLifItqpcnHP34vzzzzTTbNDpjZFBGGDayJydOc0dEmnU6f0WaDCxdO87kv/CF/9WdnGRnZgyNG4HGjOOWqcOK3w/dG5HyD3OtQ5MYFFS1Qhbty7RhPfuOLvHH4MJPTGmRGEsfctuc+Xn7xEm++Psf/5f/8d/lv/9v/K3/4h/+RTZtmCSrwkY8+xuYtUyhPkhYZcWeFajDKaLNOFHpcu3CKwy8+w0hFMlKRHNw1zsRIDV8X5Gkfk6X4niIMA7IMrFtdtDAMp2GkwKDIgPNXFwnqPmeunCHtLdKsBti+A6uIooA4TfB8D+2XQozaOfJcDeWEy2kkCEGlUsVTPkprnIM8N8PqNtCeRgqJyTKkUmVWwRo87RGGEVJIYr8stqmEEcIZnCtPJFHgMTUxyu4d23BYHv/gYxw4eBevH36Tf/7Pf4Uf/uEfYHl5gfNnL6D1JFMzNeIkJc8cYaioVissLy8wMTXFV7/+Be65634ee3TSOTQCKa7XJRjeeWb3/U9s2CD3DfAjLcCASDl95ghPPvUEzRGIKoLl5RaVaIROJ+YbTx7jgfse48Mf+iH+9Atf5/z5y3zyL/wF/HDAnYcO0O4VdLptgsCHSogQjjRLOHnyGIuXzvLBBw8xEonyqAjqgSVQBcoJXAEmz3EuR6kIJzzcOhPSCUEhFEYocuGzbfM4uYo4cvQcrYUFTNYjjS0iaDA9MYmWCikV1gqULKvHnBOY3GCGIWfnHEooJBLtShMbIcpRvUOfXwiLwiGxCCmQSKIgoFKJ0DogCEKSeICSktsO3s7C3DWkktRrVXouJ89igiDgwP797PcqHDt5mnNnL/Lcc6/w+Acf4zf/4+9x+eIyY+NVjJH4fkheFHjaQ2mBsQOsg68++Vk2b9nCzu2PilLDfL12ueCdm+pvkVZ93+F7mtzGlDlkKSVKSZQnQMDS8jVefPkZzl84x+59dZK0T6dr2bNjjK8+8SJTkxP817/wt1hZ6vMr/+JXGZ3waIx4PP7RQ1hnKKzDOIfWHkHoY5xFKMHePbvReQw2YNPUKKpYgaxDHPfopy18EmqhxeYZK0tQa4YI6a8jt8MKgRGSXGgKGVIdm8ZoiY1zWnPX6LfmqVU3YbVmfnERkxkW5laYnBzFyJzllRZJklIJIwJPMxjEJIOYKKqgI0lQCcjSAl0YfOWRFjlJu49UFoRBqPIEEUQV8iyl8AOcFWR5jtQezlmQCt8PyIrS50+ThEuXLlKtVJBBlUIn7D9wG8eOnuT5516m8bGP8MjDj/LKq69z5lSL3XvrWAFp1ifPBgSBR5oOmJqZ5amnv8ju3XvYuf0BB4Lc5Aik0KrURDfGUBRuKBmt3obrgutVMNfHQL3f8D1Toeacw9rST3TOrV03phy/43AUeR+QnDp9mOdf+AZRBMY6ktjRrEcsLvY5cTzlv/qLf5Xt23by9NPPEoQRUmpeeflVsiyjtdIC55BK0O136fX7DAYDKtUaP/hDP8yhQ4d48uvPceH8BWxWoHFUPEEgCkgTApcxFknGq1DTBVVVUJMFNZVTVTlVlVFVGTWVUVEp3YWLiKzL9k2K7tI5+isLjDeqZIM+l8+dY9DtkwwMWexorQxYXugQd1NcAc4ItFNUvQoBisAJGn5IRUpklhI6x1gYMuJrKsJR0ZKqVoSeZGKkQaAUCkGRZyRJQhhFaD9gYX6JfpzQ7fboDQZ4QYBSmjhJ6fcHOOu47cDt3HPPvYyPT/H1r36DRz9wH43GLMePL+L7AVIGWANZlpEXGZWqj5Q5rU6foydfphOfBqAwKWk2cG7Y3JPnOWmaDiWXV3/8G1bCzTe8b/E9s3M7V4oUlNFfgdYaz/PwPG9I9hxH4qDH4aMvcuXqJQ4cnCVN27TbsG/XLJ/+o9PcdtsY+/bt4OiRo7z40gs0mhV+9Ed/gJnZGhMTk/TjLmke40QZ1BVKobUkCDS6Ocqddx5iJIQ3vvk0m0f3kNqUPFlhsqbwfYUWBptZxkdgkJRig6VctwVh1/YaiQJjCJwiEgW37xzl6y9e5MLJM0xt2svCpSW2TE5wUilGmqP0OqWmWb3aJPQ9siSmv9JhcnyM0WaNV158gSLPqYYhnhacP3cBYQyPPvIg+/bsZrG1jAw9dBCQ5DkjlQpaapxUdAcx1hYMBjH9fg9rDKZIMEXB6o4oZBmVbzQb+NU6L7z8Oj/+4z/B+fMXGBkZodGY4v779jI3f5Qzp5bZvW+URJftrWHoE8d9tNJMz2guXT7DCy8/zfc9up3I8+iaPnmROF9LIaQjikK00jdyeG1z/rMOn3jv4nuG3GVjhVw7o6+SfPW+whR4vuH4yed44cVnKAqHpyI6SYd6JeLq1S6XLsL/5zf/J7bN7uQf/8P/lTfefImf//m/wo/+6A8jvZynnv4Ct9+xn7ybkOcFSkiQZdDKWUGt1mTP3tvYNjPBU1/8OivtPlM1gXBlAU3ghRRxnyIrp36IRCBdGUZb34oqAekMyJSJxhj9QZs926b5xjcXOX3kHI98MGX75mmuzveIPJ/luUW8MKASVokCH2yBdWW3VdHtcPLcaf7tr/4KvpZIa5kYqXLx/BK+gt0THg/cuw9VKDp5ii807U6LPAzxhEdiLL1ul6VWlyBKKIzFuQLnLMIapHMoIUu/XUr6SUxsYGxshGPHjvHjP/6TTExMUKlEHDy4l8tX2nz+T77I7NaQwK+QF+WYY2tzjE1pjlS4cvUcTz75JQ7u/QAzU/uQArI8xtcBOIfS5SSSYTD/W+D9vYt/T5FbKYVS6gaTvLy+2kKY8o1nnuD8xWPMbBqn18uwRcDUxGY++5k3OHRHhXNnjzEzuYWt26bpdvdw56EDXLh0jjhtsW/vAQaDDJMVaOWhpMRYSZ4X9OMcHSjCsEYz8hmbaHLp0hVmbt9GvTlOWqzgi1L8zxqIY7gu0Givbzqs8w6doxp4zF2eZ3TzGLu31rl27jArSyvc9tA9nDn+ZUYqVe6+606SrABbIJzFZAl+LaRR3cxoLeTSuYDxuscjD9xDoAQzY6NcPHeao0fe4MTrT/OE63L64hX6KCrNMS5emWP/wUNs33eQxuQMpigQroyg58ZcD28Nu9iEsFgkWIeWAuUrpIQtWzbj+SEvvfAKxuRUax6h32N6Gs6cXuDgnVuwNiFJemhP4TAoVbpKp0+f4NTpY8xM3SbCwHdZXu7G1lnnsMJateYe3Zq/qzXn7z9fexXfM+S+Gav+t1IKIUCLgMvXTvP64WfJ8m5pMqc5WjaI+4orlx1/7S//FFlW8Ku/+q/QOuKv/txPs2PnNJ3OEtObJjh96hTbd21DDStPlJAIqcmtIS0yelYhtMD3PQ7ceRdf/8KfcHCfz+xkleXLi2hnkQK0D70YtFY4oZBOIoVFYJFuaGEKUM4x6C7h2Zyi12XPthGef/0irzz5JHt33cH0xChX5pfodTost1v4WjLRrFOteChytEsYrKwwd/E4pt/lwI5xXBZT1RnhlpDWpTrn3jxD69I5VmKLN9rAr0/w+pGzCKWZ2byNYGYzoa/RnkZIjR9ocK5MsbmiVC+lwAxdH09AtVIhGynodFr4XsT8/AKf/tSn6cctJqcjcB5XLjsO3lmOKIrjjLHxGtbmpFlGo6mJ4x6vvfEq9z/wQRfqGqGvKaxx1hpwQ8p+26bv97ecy/v3k92Eoigwxqxdd261F3oVgpdfeZZ2Z45qzSfLMirRCJIah18/w+37x7jvngfZsX0nnic4f+EE2s957PEHGR1rcub0GXbv3ovJHLawYMs+byEkWntI6eGsxBhJVgjuuOM+chOysNwntwqDT5w7UJKg4lFYME5j8bCUOt5iuGilG8o2OuguZ2yZmsITlk2jI2zfNMNzT36FJz7zGe7Yu49AOJQz7Nuzg7vuuA0pDRcvHEfYmC07NpGly7zwzNcgB5mtMFg5z5Vzr1KRfR68s8mHH6rzox+7jb/1Vz/GA4du475DB5mdrDPVbLB10xQzU2M0ajXCIMT3A2q1GmGlhh9GSD9AKI1DYYXEUJaxpnnC0aOHGRsbZWFhnkceeYSHH/kA8SBjpDnJ3XcfxJiEpcUlnBNDTTgwtqAwlmazhtJw9Nhhjp84BigEgjwv8/BCyuuCDm9rda8S//1rln/PkHs1Ql5qiJlhUK0Uvi5ySy9edK+/+SKF6VGrhcRxinAB/S5cONfjh37wk0RhncuXLqM8+Imf/CEeePAO3jz8EmfOHKfRaFCrjdKoj+F7Pm4oIYxzeJ6H74dlBNhpslywZeseDt5xgMtXL3L56jxRfRSnPAonQXkID6zQODRWlBlmh8CJoTHpQA1J3qhVCT2NJwW7t2/DFgVPP/UUc1cuE/d79LoteoMWJ04d4zd/89f5p//0/82v/Zt/x7FXn+bsqcOcOfUqO7YJlOwz0VRMNB2jlZzNEzBWyYhXLtNfOYuvLKGnsHmKNSm+VvhaEQYeY2MjjI+PEUVV/DBE+z5Se1ipsEJhhERoTW8woNfrcNfdd7K4OEez2eTgwYOA4AMf+AB/82/+Ip/8kU+wY/s4p04uY2xBrRaSZQlpWqC1QCqBkI6FhXlefe0Vynx3GVn3tCfEkLhv8bfd+j/WTwt9f5rm7yGz/J2cYd/+R1JKI4QrK6esKSs0Rfkjr7QW3cLKGa7OXaDXb9NoNLGFotPusbLcIx4YHnrgcZaXO7zx5hEWFi5z//13IpXDZRmbt0xjjabT7mCKotQOdxqT5wgJSgcorRAY8rxsudw0NsmjH3mUX/3fjtCIEm772G6unlthEHephgohBXbYICKRWBTSGdyw9GR1F2/UFAtz1zDeCHE/p17fxr237ef1Y5f49X/9y6h6g8X2Zd48cY5s0MLkLUx/mRee+jLZwnF0kZK04JEPjJN35hkdqZBllv7yFaqhZKwmGQw6DFoGzwuoBwKXp2hhcS6n1+vS66dIr0JQqUJWYERaNplQar85sfoLCnw/oF6rMogTirygXg+4dvUaDz/0EF984gv82//91/nYJx7m+7/vx/iH/+jXuPd+zejINOcvXCgbcRoRcW9Amgqkizl29A0sCZKQLBtQqzSGNfBlAO+ty+Z6HON60cvNPd9/trX1bsW7eOder55hb3GYdZfrRADfBmWVlcDYHGNStDY4+kBMWLG8+vrTdDpLa+mSIPCYX1jm4sUlPvzhR3j0A4+RZ475uUV27NzDxPgMSwsreJ7Ppk2bcBj6/RaZSTDWYp3ArdZhFwWFycnIyYQhkY6lJGHfPQ+w7577mesMuDTXZmRkmoo/wuKllEZYQeKwFFgHhVXk1seYAEs5yF5InzwDl1tsMsDFLerE3Ltjkr2jPhdffJrB6ZdZeOVLVJeOssOb5yN76/z1H9zOjz4wyoybZ0vQ4RP3bmbvaINankGnh4wNpl+Q9w0STSXyqfqSuuwTFAtsmw5YmjvL/NxlsqLACE2SQy/OiNMM4cCTAkyOSQe4IkU6C9YhUVijWZzr0KyP0e8NmJ+7xp2H7mBqYpKXXniV1149TLNWY/v2kGNv9khiRzWsMegDTlGtelSqkoIu5y8f5fiZV7D08SMHInVSFojrY79vOgQOhcNjrbrNmWF8oKC0AtavL1vev7bTv3WdvVsN+/cQudeT3Nx0+S2I7db/WaZppCqcFBaIXWHbrrArHD3+EoO4Ww6zExqBII4Tev2Uj37fR0A4Tp48TRznPHDfI9x33yNoL2R5uU232y8lh6WhWo/KdyMEyitrtREGS142bvgSF3osxTHTu/bz4EfuIhYxx09fwZMhtbBORQWo3OHLHK0ypChwQmDwKGxAVvikhSItJHlhqVdDAllQ9wtC26Ipu9y7c5wHd4/STOfYW034+R/Yw1/+6B7umbHcPe342F0jfOyeBo8fbPDB2yPCpE0Di+wn+EZSDxpIfNLEkOcO6XIC2yJZOcvurQ3On73E3LUr6CAgrDUwyifODMZYPO1R9X1CLdFYPAmBVoS+h7OQxZaR+jiRX8EWrsy7x3327NrJfffeTR47fAU/8aOPcu5Un7hnmBofJ/ICTGYIfElUEQRRQeHavHn0RQQxQQWczLGkLi9ijDXfIqYmgdUZ4ENyY4ZEH6rOOrvWaluq0L51rb1biQ3vCbP8Vl/fzXXBwx/qW/yLGEr4ep7CWEGWdZ3yHIWLOXnqMMvL8zjKklGcZBDHGJMwO9tk29btfPWrX+O5557F9wJ8PyLPcjztIYUsi1VEGd0GUJ4Gq5DOUYaRQLmyAMUKgXQCv17DKU0vztF+iNYe83OLjKs+h27bxJGj5wgmFJ4SoATOSTASCihMQW5znINKXdGOu2hPE0SCTvcqhXFsmt2EkJs5fLzNtm2j+KpH0uuT9JZwqYVEkicGm4OJWxRpjsJDKQ+pNEI5hLIIabE4jHAIWzBI+kyMT5BnC0jt4fk+ItMIbVFoIl/jexJRCKypojAYV6C0HMo6BfgyAjtAaUWjVqVWq1KpVIgqAZ7WaOUzNjrD3l2WauXLCKMpco+JsQhTDFhcGGBsgNIjBL7HpQtnsSYFPISy5HmCyXMnAy2Q6kaD+noPDmtEdevX0Sp5bxrhLFj/j+8JvIt37neK4Y9ya4uphCuF+K0tECiKPGOpvUBuEkIV0WqtsLi0gJICz/MpTMHCwjLLywP279vNI488RqfTpl6vMzMzQ71WG9ajqzVCO8cw+l72Opf9zgw1wstAnnMWacvrlTDgG1//GhfPnmWs2SAMPJzNUAKKtMBTkBWG3BYYcoRKUX6MF8YElZygCmENrDb0MktiM4yX0s5iFgdLpDrBhI52aik8Q88mJC7DBJJCO2JnSIFMQOpy/Bp41RxdSdFhjPL7CNXHkJDbDONSpJI4JEr5aAVRVC1FE3DoYf1AWUNQxgWQClTZtWWcoLBgncW6FGNKZdcw8qlWq9RqNSYnJ9myZSvLKy1eeukVorCOc3DhwhytVozJA/o9hyl80tjRWerRb/d57aXXWFhexJMahUIjiHwfrWT5w9xsm8NwVx5mT4Quj7VNQrEWaBOyPIZ1gWUA4TrB383huPfAzv0O8HakXtcsJCQkac9p7dAaatWAUGsK0+PEqSPEcYdqtdQgU1KRxB5Jorjn7rsZHR3h8uXLZFnG9u3bqNVrrI5hEqIcyWNtOcPKWkde5BjjENhy58IgnEWuRmedQ9UUv/s7v81g4QIP7t/MaCWn7gkCYThz+hIjY7DsoLDlsjKmDKLJoabC6qoKAqg0yrUpvYD6hCbNNOevzXPhwoBrHZAXFplKK8xM1WhMBCg7KH1haQglBAqSQfkdWmegMNc3tOF6tsaBNES1BsevXGViymN8YpQ8N2RpgVQRzhUM+imeFghy8iwjz3LSLMGI8gkb1TqVWo1Br88g7lLkjn5/gDGGkydP8MYbb3Du3Bmmp8cZH5/knrsPcubscarhOMbF5Jkl9D0aUYiUEcYIuq0Bl85fZXJsDyiHVhpXOFxRIIbVamuB8WEZ75q5LRXXd+y3W1+rROfdy+Rb4D2+c7+Dbh4BYJHSkRcxg7iNVo56JSS1Lb789Gd5+tkv4UQGwpHEGUFQJQwjmo0mBw/eycmTJ3nuuW/ywgsvEEY+jUaNoijKQg2gKHKKohgO1rMU1pI7QzGsgrOmjNCXfxe44ZEmA/r9LoGvqVfLAJqyZSejKSD0INQlmU0BWQZxAnE6PDJoDcB5gkEO3VigojG6qeSrz1zis19e5shZ+PwT8NRzA85dSUiKkMSErPSg04M4h6QQZMPnTBNIUkhzMMPJJb4HWjtMYWk0Rzh1ssXs7DZGx0bKEcBJAsYhERRZTp5mFHkpCOGEpDCOPM3J8pzCFBhTkOdl5ZkjJ8uS4TDDgEajgXOChfkVWis9tm7Zx6mTBUVewZmIIg9YmB+wvBSTp5LWYszK4oCXnn+NohD0Wj3yHBBKODsUOF/1l936AOzQx6YMshnkMN14i0OIb7HM1s+Xe3fh/bFz3/zNr2/vpVg7mvUQCMjMIs+88BVee/15zl04Q5IuE0ZlwE4IRZFbkrjPxMQWdu7axZVLVxACZmdnmZ6axvO8IbktUorh3wYhFNau9jsrFBbpJMo5hBMIcb2MtDAZ3//9H+XJP/kUvV4fPd4kXunhwoKt20Y5f3GFcPq6ZSs1OKmQ0kcqjdQKKwXtXgcVNUhNTkGAFCMs9+DoBTi5DDUFHQNcgK07FJu3jBDpCoYMpROECnBC0BjRuMLgjMEVOc4mrCovrfLCDk3ylY5ja1iOO7KFwRqLyTN8L8D6GiUMWmjQ5T/nRYbNHUKWpnu32ybNBhjraDYjhPBQMmBmZgYpJFFYpVKNMIXkAw9/iM9//gkeeeiD7Nu/k6JImF+Y4/y58yzMrxCohGbN0G1nOOeRJxmeX+bUhVXgVvev4U69GmErS9hwQ1GtG6v3r2P9f99ipb2r8R4n92qect2Ptnrz2tk5AwoXZy2cGNDpzfPsc1/lU3/8Rxw+cpLpGcWOHVtZXlnAZhmN+ggLcwnz8wM+9OgUk5PTHD9yga1bt3HgwO1s3bYFpSTGpmVzhNDDHVyilUduLMqV4gallyYRwqHWTa4Tw9r2Bx68n5ee/DIrK23c9gaFKbAU+F4pWmgygXUeSpQFMEL6OOdhncTkjhzwghGsDZCeRIoKK72QuZU+hYWqB/VmlcAUCJHT6zXpDaZQVYcfRES6wFcGE/cppEZZUBhQBcgEaxNsEZPbggKFCiP6/T6Tk7C8Msely5fYM72PyId2UvaEGyURWDwlUVKCy0m8sgRXConnaQJf4fmSPE8By2DQxRQ96vURoqiCc3D2zAVeGzvCj/3YJ6lXGwgXcdfdH6Q52qTdWiQZpGQFdHt98syRpwbfr4ui4jmpQpFlEiEFns8wjV3GQVjbhcv18nY9Yusnx93aGn937tbr8S4m97esHbzxccKts9BXTa8MyIZPEAmp+u5Pv/JHfOaPP8uVa5cYn5BMTkkG8QAnuqRZjyIxzM5s5ny/YDCAPXt34mmfa3PXaLVaAIRBQBD69PsJUDYmlOQu20iNM2tdURaLcA6HxbpyjyjfkEOpkMVWm4WFHl6tDMZF1QpCGY4dX2DX7lEW4wLrQnBhOSnESNI0pzNo0+7F9DJBfSxiqbOEiqo4P+PIiQGvHF2iO1AopVns5dT8iIv9lPibc3TbMDujqEc5o1WLSRK68wMmmxJfQuT5VCKPSuTh62FwySZIrUD5LCwtsX/vDF96/hq7L8/xyPc1SW3CUmcZX0tik8HwsyupkFKUskzGYIVbVwJsMTYvXaEkochhcnKGkdFRnBNcuHCJmZlN7Np1gGZjihPHL5AOQIzWGBkJYSQSZeCrpGF3MHBJqggqI0I4Xbbcrua6ZblErAQ5jITItV1b3DCR/WZH7x04fu9avCvI7W7aeMuo6/UB8TAsHcUiEGuPtdZSmAytdCkl5FJyEztPgyyLFESnf8q9eeRld+T4y7z8+tOcPH0YqR1BOM70rGKlBd3+AlLnpRqJ9mi1LYIGu3ftJs8MJ0+e4ujRI9RqdX7ohz8OlH62kOUPXzafSIrClHXkIhtqkw3LJlx5AnIwXGmW3iBmYnITlXqFTvcK3X5C3UoKYen0DU44jClHaygVkMQFV660OXGyz7mrKZ3hWJ0iHNCKHQQ9hNQsrmS0cvC0jxYV4sISqAYSwVy7xVMvnKMWCUYjQcOHNLH0urCpDjumYPeOgNmZEZzROOkQ0iGFQyhZCi4M2kxM7WB6ssdXvvhF9h16iC17DyFdTtpvQZEiBXhSgclJ+z1skZc+uS/xfI21BikVfuBRFDlB4ON5gjRNGGmOcNdddxNFFR568GEuXrjMnt0HOH3qPJ1OwvTmQKS9zDnP4AURDokEgooniszAUANutZ23gLVGm+tVE6LsUhs2096U9LoB6yfHrVWjD7MCwLo1+u7Du4LcN2O151pKMQxE5cNmgPUm1eqX6yjswOEynMvRWiJxLHfOcv7cKffcy0/yyuvf5MqVM0iVM7s1QoicVncBqcq+6STN0R5kaUYSG7CWkZEa42NTxElCtVpj79597Ni5g5GRJkk8oCgyhHQURQGUumSDQYwfStRQimg1cyqdQAwjsm71ZGUNtZFRPvz9j/PU5/6A0xfmuG9Hg07nCtv21Fnu9IkzhfPKSjfjLHHWY7mVsrAMmYbAgzR3OAWDtBwtpAKIJAwyS64MUVQnNQbpBAqwAgrn6A4cSQcCDbVGGUALKoLR8QZjY018Dbh0yIih2HOR42tJ6Gnuu2svv/uFV3jhuafZtH0P02NN0iyh4gmcLfCQJFlM0utSZBlpmmFTQeSXUk5Slm5MmmZ4OsBawUprhWZ9nEajzvLyCleuXOEP/uCP2LRpM2fOnCNJCsAH5+Gcj0FihlurQKB8TTEsy3U3l0IANzrO5Y3Kld11bv3jyqqI4f84Vs/ibt2TOifK1KbcIPe3xM3fjZRyWPcthq2Z5RQKAGcdlmFbn5R42sPYmML1Eaqs3T5/9TzfeP7LfO3rX+LSpTPU6h7VmsZhMDYBYdZMttWIsHOCJCno9xKMKWjURwiCCv1en+3bd6CVz67dO6jV6ghZmuCIct6Ws+UJSaiStNbYcp50Wf4xNM+H6e+hBxEFEecvX+WxD38/l06e4PjLX2P/bI26F1EZ9Vicu4IKDYY+xmV4UcTWnTUqI4oDHVc6HIFAB4524khRuGCUuRa88uYCS+dSbNHFCwRZGmNlxsxEwN23b2bnthCTrZC0W0zUBFNNSWtxwObpiJmxGpHvsCbBmAHOphgKiqLMu1ejAIVjYnSUQwe3c+70Mc6ePMptd97PxStX8bSi02vTz0vt88JaMI7QUwjPRw0FGp0TOFtqnrvhCURJBViMyVmYn+fV117jrkN3MzU1RavVot/qlOozlZpAecR2mKUacm615v4Gb/gmr+2GS1fGP4Sza2R2iNLSGu7zjjIQiqV0rYY7tVQC58qecWMsSr37Ek/vCnKvYr2pM7xlOFe6nPpmbBmVXh0gr9BIVRJf4phfvsaLrz3PM888yZmzx8jzPvVmSJ730JS9xs7Z4Zm4KPOdq69kFTPTU5gErl1psXPHTjzP59XXXueFF17g7JlzLCzOs3PndiaqTbJMIGTp12IlTmu0DgmDClk7pigypLBIzFoXlxGCUpIXltMBkY5ojE1y+113ceT5r/LiG6f5kcfu4OLcWXyl8EOLcBnG5WgNo7UaIxPjZM6RI8ilohCK9iAl1xWqY5vpZRF+4wxGnObS5YLctPECmB73uevObdx3z252bqlBsUDcvoRHSkUJpiahFkT4IqYwGYVJsLaUi7KujGJ4SuMFIYMsJqprPOU4eeRNLp87wz333k/aWaFXZHR7XUyW4gTURkbQStKo1qiNjCGGGucSf02NVSk9jMSXPvnmzbN8/BMfo1qt8vBDj6C1z/nzZ4nTPigfmw+w1pbR+ZsX0bfcRG+M4UgxDCCK1TiAWGcUrkbVBThbklyWtv3qoIbS1BdD0Y8/62r/zuNdQ+5VdZT1Pdalb2NLmR23Kq5QTsm4joK5paucufAabx5+hWeeeYqTJ48SRprNW6aJqop2x5HnCVm26oGtOvmrH99hC83oWJNWt5zGMTNTo99P+I3/8B/50peeZ3ws5Gf+4k+DsFy9eoW8SFBK4fs+SvrgfHxPgpNoqRCeLof4UcooQZkeM6IMAuX5gEZUJy4Ee26/k713PMi1o6+y1DfkmWPzVIN+vIhxYK1DpH20lyC9Ck56WKmxQuKHVWSWEycdkmUP4Y8zOzvOwUM5OrzM8kKCLxSzsyPUG4r5hfMkvYypEUezYsn6bXr9LlunpnFFTpEnYAtQBj1srXSAtRIlPYyGXpLiSYNNEyabdTZvmqA63mSiWeX8hUWqviSq1RGeotJocubiZZZby8wvLKC8kJmJabLUkGWlBeWcLHXXjCOKKpw6fZJf//VfY+++vezbt5eDB+8YFgqVrZ29Xss5K2mOTwrpbiTs6u95Swh3w2PKySnl/LTy/vXraliZ5obzz4dlrA5HUbjy1xz2jNt3p1X+3SX36u+yPkB2PUAhKPKCrEix1jjnHL7vCU97rCYoOt2O68ctvvzVJ3jyG59lbuESeZ6xZctWlLa0Wi2WV3JGR2vgBGkaI9Zmvw5DKcM8qHOaQb9gYX6ZJIF6PaReb1Kv1ZgYjwiCgJWVFRYXlzAmJsvjIbkDpAjAaXyvQhhGQF4eQ/UU4dxaT7ZBY4TGAecuXUW4SaxV7Ni/i978JT71p2/wY9+3g+X+MsGwiEWKsmisMI48y0CD8CTCCeYX5mj3Yy7MGc5evUarDzr0QEVoKan4km2zk1QDycK1y1w916caWXZv99i9NSKUFq1gpbWIictacwX4+vqgPQdYY8nSFazs0nM+hE3mr7WYmd1BM5AsnTxCnvYZH6mVvdf9DivdNjqqcvrsGUYnN3Hnvv0YPNqthKIQFAVIW/ZprbpfcRyzZcssH/noh5ibm6PVXiQIJY6Ao8eO8qEPXXSN0Wa5xZqeuyWvxNuULNpbNHivNogAa72p18tNy4i8KeWa0aV8snMWk+dI3xtWP74Lt22+y+S2dtWHeet9zln6g74LAl9Uaw2xPhriSLh48YJ74403OXHyTY6dfJ6FpUW08qjX6tQaEUpZwiggSfrkeYbnVQiD6tD0X60TXv2xJc4papUm1UrGxMQKmzdPcO+99/Hf/d//Hj/5k+d45ZVXuHTxAo984P6hvlq7lDpSHlgPayRaVwgCnzhuYWxSxmRdGUSzQuLQFHhYofCCkF6vg1eJiELBo49/H3KQ8sS5T7PrwJ0kK+foLh/F0zmBXyHNBGZQYI1CSg8pAoT0aNRCxqbqNCYyMi7ROj4gGViaowGzk1MMKilVz6O9dJU8TRgfc2yaDBkfqSCRBBpGJxpUtE8ep9jc4mlN6HlIHMZmWJsPjVRJZjWJqEK1SjWAybEaVy+e5fU3DtNqdzlz+gxZnrGysszCSkxzrMaFuRUe/uBj7Nm3n02zu9m2ZZJ2u0+WZUgl8bReq0kfGxvl05/+NJ///FfYvn2KOO4RRT779k1SrWlykyMHLSeEQIb+9V13PZlvuXEPF9labfjbpVnXN484h1Ji0O44h6Q6Mi5Kc1zgrMUMn0lu7NxvRemrrJ4l33qfMYYTJ064dqeFVorCFPR6Pebnr3HixAkOHz7CiZOHsaLN2KSH7wt6vS7dXkq1BtMz4zibc+5CB8+DanW4FlYtBjfMkzqFsY6ZyXEW51ssL8Obbxzl05/6DO1WjJI+mzbNor1Zzp87z9lzJ0mzflmaLDXWKKyRKBkSBB5Z3gcbD2vJy06w0vv2MMIvh/gpn2o15OigTVMbGq7F4RMXubxgefG1N7HdOWRWUAvA0wlpBnHsME6gApCeIxfQ6vepjqYMDHSXDe0FWGpbpL8MtMlTRzNQ9Psp2jkCAW6zxqYevaIgcSkeA2xmyGOLLRyBp/CVwhpDnhscZQlqGEBmBYlYpm0vc/lSxuXlIzz9/CkuXkmpNy1jY2UJ6eTkOOMTgomZGTqDl+i2Fzl18gQXLi4SBBN0OjFZVro22isDadYYwshjYWGOj3/iA+zdu4fmSI1Tp4+zuLzEiVPHuHjlPM4YsvYKE5WwdCHKb/nbrDY1JPbQUhveWs5jK0tM3TD3jZBYobBIrNCuF6fUm2NsCSLnV5tCKYdZ93Lv1nKW7zq5y93vVuQuGAwGtFotOt0O1Wq01olVqVTZtXs3mzdv4aPf9yHCisUPDMgMIcG6jKJIMCZHKUkYVsuh84VBrHb8OI1b3cGHzRzjo02++exz5OlXyHPL1atzBH6V9soi7U6bSjViELfJsgFZnpRSTcoD5+OsRKmQwPfJ0i7WJsh1tctlP7amEAFGagonGB0fQ7ucubkLVIoljCuIImi3u3Tn+zQDkBaUsKQxZGn5XUknyNKUgTFoP2RpYcB8O2XuakYSQ1E4isKgBAjr6Bc5oQdZAufOgssH2NsF2zdFZLkj6w1ohJI0tpgM8CSFKhtg0tyiNBQe9NulZVr4pSt1576QKysJ7UHC/QdHmJweI88G1Oo1jHW0uj0qXg6FIu5k9Nst+n1wIqPbTUizBK1VuXMLV/rUEoRWPPDgQzTqNfI8wbmMsRGfF5/9KqFI8CWYzhIj2iBtwfrNwa2GxtfVQzg39K9Rw5TkkNAOnCyJXKzmvmXZIZYjSQpo9VK27d7HA498kObkJOPV5lBd53qO3Fpu6Dh+t+C7Sm7P02XuGtakh1cj5Vp7jI6Oidtui5y1Bs9T5YjYoX8mEGhP4/uekNJhbOKcy/F8gVaWLB+QJAOEkNRrDYyT5LkDPFYJbdfMs7L4v+bXRS3a6l5+4SyjzWkefOBRlhcXScYGdLt1HAWV0C9TaqYoU3ZorJU4FIFfoVat0+2ukJsELQzK2WFKrPS7U+GXYogGKvU6kS8Z27+dzsXX+fqbLzE9pjm4e5YrXo+oVuApg84DdBaijUYjQVlylZNKRV5p0nd1zjx/hmutjLkY8HyqoU+v01/rbNQOJkdDsn7GiQuWel1wYM8Eo1GV/vJFNo9VKOIck2i0iEAF5BSk9HE6wXMGYke14mE9RWwN25QizqtYLGHkCKMYIQTLrTlU0CSfabA46FC0B+y6dwf33nkPSz2DV23Q6fYpsqysX1AS49wwZ60Iooh6vY5ylixpc9vuneybrbNy5SJq/hgjDQ9plqm4BOks1mlAg1O4oYKaFJAkfazJqFcjIr9UxTGJocgtGg8/DOnmBX0BtWoDg6YVF3QGBhHWGZ/Zyb47drP3zgfYtmsv1fpqPAWUFEAZMPVleeJ4t+G7Su7VXuhVrI+UK6Wp1erUavV36NE0ho8rS09Db4TQu/6lS+Hj+Td+XLfuUmAAxWhzB8I10LLGtq07SfoDmvWI0UZIUSR4nkIMK+akKFVJcwPOKaKwSqM5gh8o8jzFFwaPAi3KfcEISSZ8CjxaiWF0YhxMxuaJKk0zRTMSeGFBSMye7U36YonCWfxUU8sqVKxGFgZDTBFYsjAkr9XprhguLRoW+2Xu16QCoXJk6KhWJUnf0erCtpE6I6Nw8cwyV+YTllp9Nk+FjNVHqLgBwjPgl2N8UQqjNbHOyUSCb6A54hN4pVsRZwm5S/GaCt8TZEmbNG6DCHAmJVA50dh2qn2fmQZsnqyzeWYzsjXAq1fxIkWRZuXpVUqsAyt9pBcRRFUqlSqKAjsImBipU1eWqGrYPyaYHQGR5wRehnB2mG8ufwM37FF1GKKwiVYFg26HIjV4SlAdVQQ6xKaCXtIl9hVJNSIRGXFhCKuSaX+Mqa37OXDXI2zbfx8i2gqEAhyGUhNAiusrSAnYIPd3CDd27Kyn7HA+7bCCbC0oOnyEFavxlTJF5qOQwkd7EUmS0+v1sc6SZhlJmuBMjrFFGea3dhglleSFA1eafJ7v048T8jwlFwbfZWhRoHAYIchFQSE1zkiSToswkLQWesyfO4tHzNQoZIMe2ovJKbASrEnJ8z5JplDGYpUhF5ZUWYoCXnntLCfODOhkmtD36PVTksRy+74mk5MR8aDPiaNdGtWQibFJkp5hfm6ZF165wOToJHfsGqN7rY3Kc2RWOivKAyslzmbgMooc+oVi4FKssFhhcNJiTEGhQJfDVej3UprNiJXegFZyGTW6m0ZTsbQ0x6VLl7FhjSIeEMd9sjgBBELpcgf3VKn6iiPLC5TIEdYwiLvkSYqHw3MJMnPYbBlrBsMftAfWxxGAK90uY3OkF+Iph81XSAcFuQMbSHIvQhiPJLMMrE/XOHpWovwm05u2sHnXHUztvYuJLXshGmOYAMPh4dbEHIYrabXg5V0YVHtfkHstfSnW9/isP94+OloGvVYFFj0q1YggDOgPBsRxClKT5ymFZUjqskrOueH/OlvOunZgbNm7LRA4qcr6NFemrKxzOFme+4UTNCoRy8vzTO7YQlXkfP211zhz/Bo/+NAEM9OTHDt8BX8MlF8WWjhSMjRKKoTyKYRHUgScPbvA4SMx3QFkrqBacUSBZaTR4NC+A+Ay6ltDFi9+k2oIe3ZOo4oVnr62zGtHHLs2d9m1ZYKcOk7kCGmRtlRLkU7huTLwWFhDnDpMVlAogQoUUitMUbo0vge+FtTHA6LGJItpi1YflJeTWU1nkNDpd6lF9aEqTVnAIgXDFlaN8n2CKERqjbMGIUFLSRoPSBNHqMoZ405kWGfWBcrz0vF1htUlraVlaWGFwkGj6TE2XSHLDP2+Y6Wb4mlFpT7JIHZ0Us3Mtj1s33uQ6X130JjZBc0ZoIKzHghfCBFSdqzLG3l8487yrsL7gtw3YvVblsMrb/+tl05AqXYphk389UadarXK5ZUFBmmK1B4mhdyULQqlR7fa3bX+ucsSRodF+x62kAgnr2sEuKx8N0IgsRRJj9F6QCOA4y+/zLHXjzASeWyaHKW30kYLhTIGbUDhQOZlflsEOF2hIKA7kLzw4jnOXymFHaIAJsY90p5jolFh5+wmLpw/y/bpTfgoyDvMTkXUvGnOnbvIqUsFbxzO2Ll1gR0zE6BikAkmH2BcjGcl2km0VWgtaMzUiJOMDIn0AqwoNeCSNKUoILUam4DKc/BHaUR1llIfHWhGJ8eojowifQ8jJJ7y0WE5JFH7AVL6CM9HBz4ORZblCAGeliSDHv2BZWLUw/MkqyKG12PfcKNoZln8FIaC3Dr6cc4gy9FBhXB8BJ+IwQAutDP8+iYO7L2bXQfvZez2Q9CYKSsOCw9ReBirkL6P0NepItcbh+9ivH/IvVoyeMsi/vW5TbGOkqs7+2rlmqHRqFGtVRikCUmaDNs4IbcOrSRaDivPbFlXDg65Oj6Iss1QKI1zAiwYDNhSugEsYtjtNui32bV9K3PnjvOFT30Gka7wg584SMWTvPH8SR54YIyldgthLFpakBbpeUjtkRLR6WvmVjJOnBV0Esf4FMxs0WzfNsnF0z2KfoHnDL4VRMrDppJs0Cb0EyZ3TbF/5xjXLs1z7prh+ZfbTH5sMxWtCUKJFSk2HSCtQ1sfbSVZYbnaXSEXgNaoQIMOyWWI85s4qcido9vtMegWbNq6lcnJzZw7epZ+ZpFBQC8ZkCc5o+NTSKVQWhGGIdoPQKxKSV4vQ4ZytlgyGBD3Lf6kwtMOjCmnrqxTR1r1gYUrQJSnX6EFWktSJ0iNpJOXohLoCL82TqPRZP8dj7H9rg9BYwqqDcgkZFBkoIJQ6KgKw5jADTGa9VdWw+bvMrx/yL2G1fP5umKVW+zewjkQBlFqUruyvjgX9VpV1KqhS5M+WZYShvUyleUo/S2hhueR1RNJ2XkinENIgxRuOPbGIa3FWctQjQlNmcoSwjBa8zn5xgu8+dIzdOfPcc/OSXbMTpMvXiPQEEgPD9YWjwPQFutp4lgxt5xx5mKbXgy+hJEmHLpjK7fv20m6dJJj5xdJ2suMRhFmkCDzMrTg8mUa9RkOHAiZuwwnz8DRk45Dd/aYHPMZbXpoX2MKWUoDFxaFh6ckwbiPVQEpHnGmSIyHVTWEH5CaUsp5bGYb7UuXSV0NzwbMt/o47TMxs4nN27bR6WfkxgASOUwlaq0x1mGNw+ZFmWt2ZS5DK8mg2yeNTbnbK1FOS8Ss6S6IYWSlPMcOmz2kpB9bMgHhaISSFeKupd2HoBFxcNch9t73YaLZO8GbBOeVEgBGAJ7wogD8Mue3ntis/ia3+vtdhvcXuW/i8A2/wTB4dt0/pyS2GMowOQNCOqiKasUnzxKKIsPTpc/sGI4ARg6fw5XLaNXwL1uMsFjywlCYVfl7gVYSqTw85QgUBEpz+fxFnvvqnzJYvsrDd+1k12TE/MWzNFXOgb1NWstLa62ixllyB0Y5EJaVtODc1Q4nTi1irWPPTp+tuyvs2jHJ9KRPoB0mzjCDLpE/RtYbUA0ctRDyZBmTajZNj3D77R1WhiW6rx25wN7dU6jQpxFI0IJypp5AWIEQDmMgl5alVocT5wsuLzhyYUBJur1yTPFIs8alKx286DiV0QYnLnVIFVy8cpWtc3NEtRE8LwKXo3BrgU43LAhz1mLFqopsORIoT/ukqcNTCk85BGVQU1z/2ocnQcGq7pmxEFZKVZerCwMGWOqTO7nn7nvZvv8+qltvx2tsBjUOpiqwqjxDBMNUqSrbPPsxKA2ezzDOsm6dOW61b7xr8P4g9w320qoJvr7Bj+vsXrvXAgUI4xA5qxMpERBohysStCg7ztSwG4hhe6JZW41lMayxw1SX01hX4FyBFRIxTJcJpVHaEYWKkchjdrzBr/+rX6a/dIGHD+3h0O5NmM41WleuoALHZDOinxq09ilMVib3HCAdzji6Scbcco8Tly0F8H133sb2PT7jDY+kexWXrTBS0/gKXJ4Rd1NGKo6xOuTxEp2VglpYZ/fOzZw5nXF1ecAbRzKixjITs5NEFQ/lDb+3woEpRxsN4hjPD7HKx6tYqqOaytg2ZjbvRenSH4+ikLuspTvooKOQ/YWhbwvqU1P0BwNqzUmisIpz8Vp1mXVumMkQaKWwDvK8KBWHcUgBpSKTQQ/nCJhVEdOCYWRFYWw5ScSp8mj1B3TyAn9kM7Nb97B53z1M7bsff3oveONAHTJfYD3Q4ZoJ4BwUBWXeXYJYnV3wtkR+d04Lfe+T+y0mkhgW/rvhTeWZXApZ9nCvnuVxYA0u7iH8ohTzKwagCyYnGngu5dK5U+zdvYMzgy6eVDjrQCmkLFNr5aIqUKp0BYQsBSZ8XzMY5ARBQORLGhWfyWYFE3dIe8v85r//XdL2FbZP1JisCkhWIGkTkJOnlv7A4gchy0sxs5snuNbqkJMRhiGDQnL+apeXD/fxlGDvzjGmJupMjXpEsofNuyhXgKXMrwtHo1nHZII8hkBYQpnji5zxRo3b926h17vCaxd7BIdjtu1KiCqWUd8nT3MQPpVKjc7yIq6u6CUZzfEZFo6cpTq1mR/4Cz/J9JaDdLoZSK+sItQSYzOcgtQZOllCN8vIHBSFRWsP37NYOzwJDyeuKiTWOgI/wNeCtL9MbXSMb77xGp6O2bp5F3kSY+I+yirSxFKt+gx6hixz1GtjFFaz3BrQKzKCxhhb9uxg6+33MLLvEMHYFoQ/AYyCGwVRFWutXWq4dqAktLjeOiLkjUtMrC4iMVQ+FQ4IvmNL/D8V731yvw1Ko3hoRiOJswwMaMrfU/lDcmoBNgM8cCkQs33bFNumx8j6LbZOT3CmWkGH0bDvWGCswWFRsjQRXZ4isFQin1q9gVU5hpioUsHXkijQhGHESnuBMycP85Uvfp579s6yfSwgdANMt40u+lQDCcZSFAValWWZxgp04GOzDOFV6Pc9Dh+/zHIGm2pw+/5NNEKJZxJIe3gyw1cCjEWIDGSBF3jkw1FYoVZE0mKzGJ+ILTMjtHZnHL3YY6XreOGVZcZ/YJbU5oReWE46TTOiapWeSMlySzWostw1BNNVJrbsojG9mY5r4fll8b6UAs8DJwzSFWAyVJbSGcQIoVHaxwsAI6+rmUiJQpAbt3ayNEoghePY0dep1zLGxyJs0cMVGSAonMb3m/TJ6A0SrNQUIiTXFcanJth24DZmbruTaPsemNgCVKCIgArW1ERmNFqB9liz2taSp6rku3vLilrVS10l9mrqdYPcf/5Ytb7X7+BD09zd8CAxFGoY/oMzOArXby1x9fwRiqJHzdPMbN7i/KRFM7QsXj6Jy/p4GFyRoXwPm5elp+XcsdK8d9YgMBRWYUyOszm+FqU4v3BkRUYcw6Df4egbrxJp2Dk7yUzFoNMVdN5D2wTpUVaDOEeaZTTHR1lstfGbVTzRJE415y4mnDjhGBEwMabYtmmEqbqHypcpshbSy/Fw+D6gDFmaMMh7OOXwA/CkxKYZRZbi6YjxxijbN49wYLvm6nLBS6/l7NnT5d79FcJqlf5yFxnnTM6M0+0uIpzCWIlTghxBLzN4haPvJLJwuMIgJcjCIKTDCEPhLA6N71fQXjgs+y2DnauKO6uQcjhnWxhGGnV67RZnTl1iagK0TEuZaCURtkBIn8JEWOFjVUTf1onqU2yb3c62ex+guWc/NMbK0SyE4ALQDQEhGEmWl8tGacqa9DVrj+Hl9cV1o5zizWLI9l3pfb/3yQ031qrcEC13az+L1hrtiTJlUuRQZDiRsXzlAs89/SRXL51g82iN7dPTtJZXSDsrvPLsy1w5d4zu8hypVeioWqZ8rCtTLbI0y61JEM4QJx55kbPSGmBsmfryfA/lKYQs0zSXz59hdmqEibpP5DqYtItJu2hl8QKFkJrMOEzh1vRbTaGJ6uOcudTjhRcX6AE7xwR37B9n63RILTLE/Zg0HSDCcgcUylJIQyZTUlKKYeJAC40sCkhi/OqAoNLEbq7y4ANb+MJXz5F34ctfXWbPlr1MVDTdtMNo4BNnGUIM67dRZUZZQiEEmRCkwiGlxYryhCetGba7AkIhlSRUAoQmSzJMYXGmrDGQw/dmERjnyIuMauDRqNU5d/Qkx462+MRDFQLPITKDEg7P90GGtPs5AxNSnZhkeuttNGb3MrplF9G+g9CcAGtxTmByiXA+0vMRSKQsY2elP+1wa4VM17HaP1a63qvqteuVzt/FoXLeL+SG6+ReV/O76m8LYJBkztdKVLTCphlS5k54jka9QiXUUCT0lrtc6s0TRgGT1RFOXzT0W9cYrQV0UlfuQNJHS4dxrpTdEQ5QSAdSKTxPkcR9QGGLCOGVyizOGdJkwPLCPHtv34ZL++TZMqRddF5qcWJLUQAnNUZDJ+6jKhUyFxCKCqfOdXnjTMGYB9u3Bhw8sJmK6hJQYGwybBCROCPJi5xCZBjfwyhTSjMZwGgCJ5HE+CYF26bqB+zbNcWl+Tl6L8WcnodX3+gw+sAYlfo4Rdqh0+8jfA8hSnKX1QGCQkAuDBkGKWw5cguHNJS+9DDIWVajKRwa6+T1dKIrbWGxGv2GciqLUyglOHv2LCtLkpnprWgtEZlBSofnle2z7ZUEVWkyu+cAe+/7KGw5ANVxnKpA4a+Ne0osSDzhOVF2y7lSkEJISo27oQPnbig5s2t/rdqBYi29erNS27sP774Q338qxM1Xbvy+pRSrAi8ILcFTCAEjU+Ns2zbL5FiTug8iWaEiMrZNVqjpPq1rl5kYqTHRrBMFPloMg3OyPJRUqGFnUynsKKlGHrVQEyoIPInvK7Ik5uqly3TbBRVfkCcdXN4nFI6qB54qy1rzoijbD5UiwyH8EL86zpVrCUfPdOgA02OKO/aPMDkiKQZXEckcocuoaA9PhJhCkea2TFP5AvyhinsOznr4MiISPr5NcekcJrlC5Md84OH9jI8GRMA3npnj7IWcxvg0ibMUYqhG6FRZXuvEcPqnoRAFucgxyuCUw0mLVRaDw+Cw1pVqRgXgJJ4f4nkeWvtlcE1rfB3gex6B76GlAusYDAYcPfIm1cgy2qyXpX62KIuGhCM1Oam1VMfGmd29D3YdgNFpiMZJjU9ifJGrpsj9EaHDEaHCOsiyd98Wbugur/rRq5mU9Sb4+pUkYW2mtwb8tcPhf6dW9X8W3n879w24fs6NQr8MiDqH8IeN+86AyahVKpgsxmU9RNbBDiSjkSHSbV55/lk+OLoJ53zyuCAXHvmwWLWsjykwRQ7Duuw0TZBSIK0Fk6OcJfA0g0Gba1cvU4ugWa/ikxICNSkIcFggcZStj9ZhFHiVkNgaAhVy+Ogc5053GQGmZ2rs3b0Nmy/gkgWcVGgr0SLCigCcR+4chSsQvsWFstxlC8AoNB6gEKaPMzHOSvAiGtVN3HfvCIsrCyz3LMdOrbBrs0ezWSPttPHQSKfKslqgzOpbDIZC5DhyrFJIOySMszhbNteUiqcSYQUUlqIwlIn0obSWM1gBZrW0VziWFhc4dvgwe3aXQhEmy8AUKCkoTEacFqigwuj0NNWZTWVSHAXCF0QBCdKtesxDSgoPsEWCMgI8b83Su2kruGltDe8VQ5dvmCl5dxvl76edG9b1jMih6Py6uxx0ugPX63QcttwBiAdQidixfRuz05M0Ip9m5BF5gpnJkKkxydHXD5MN2mhZKpRUwoBqpUJl7ahSqVWpVGpE1QphtYKWkKfpmr65pxV5lrK4MMfUZJ1GrUroKZS0COHWZLzKkEFpIBYIZKBJi4zzFy9z9HSPgYEdUx57dk7RrIfYrIunEjz6yCJDWNAiQJW2MUYZjDJYbbHKlV1wzkMYD5E7pMnK1JhnUfQZ9Fc4dOf9zG6qU4/g2IklXnz9Kk6VM8eFG9bLrwodONaJN1ssBYVNyV2GxZQckGXxjxQKhQTjyHNDkRvyzFDkOUWek+cFeZ6T5zngEMIxN7/I6TOL3HZwO1JasjzHOIMQ5f3WFkgtiRpVaNRASPI4Iy0gF5JEQMs5Wrbg/9/emwZJdl33nb9779tzq33trXqpXtDoxkaABCiClERRsqSRTcmWLc/Y40V2hDWLZz6MxzER9nwYz3gJhUOWYmSPZXu0WTtJyaIkStxJECQIgFgaDXSj96rqrr0yK7e33Xvnw8usqm40RGhM0GAj/x2vc6mXWZUv3/+dc8/5n3PaZGg0hhQhUytkYiGBnWZJfR2E3NVEWEFR7aPAOr3bPSH1vnrwHcry73xy711r77n89p0s0XO4XAHFmBugp/3OUwNORDgyCSrA5Ck+KTLrUArA96p848WYRmOTTtwlyeKi7W8Wk6ddTJ5isowsTkmTjCwrXF8/qOD5ESCQBjwh0N02G8s38RwJOkVSRJa7HUsrhrg3VVNKVdSdC0VsIxJV49lXNlm81cICY2ND3H//Iaxto5yUKALHAWPywtXERcmC3Na6CFvo2h1ZrDWlKKrXkjxBmxzPg1JkUcTUIoEnYp583zFkVObiBly4VOfGSotoeJIY0LIYgmClKMQ6Ou0pSYrupFmekOuM3OpirS0VQjgIHIR1UNLF7/Voc51ivrn0JMqTOK7EdQS+kvhCYDs5N6/B8UOHcGyOztqYPMGSI30H/DKxdenkooiIl8q4pTJSeUUUHPCFwJOKwkntF/6IYgKoztnRBvfPGrv3ZOqRfaely56Ta8/L3qHcvgfILfbc9mXkgl52W+5U31ospSgQpVKpFxvxhKpMgByio4fZf/y9zIzPUiLDzbuUw4DxqUlaWYenX3qJzHFwSgFx2kTamJLKkOk2NmkTOi6hV8LakCwPSfISaR4SeMVETdVNydZX6awscGRygqzVQqeWzPq45Qq5dOlogV+p4bplVpc7IKo081murJd46YrmZgwHZlweeWwEP2rRaC6Q2TaptbSNJXEcEtehbTSpzvAdl8iOYLcVftcQJBbHghYxqdMl9XMSt4jIGwMllZNsXUd1r3LioMfjZ11qLpy7Al96vsvVTYMardGSMfV0m9RqwsinWvIIFbgmx7EaRwhUL7ihbTH21+RgMwG5RKYg4py03UHYHD9y0SqllW2RmRZWx0xWytitBh/7hX/NI/vh+Og4bDcIyRgZFmgJLRvRdsbperMcfezDUBon2WpSzCJN0VlqHW2ogCgjKCFwEUgcHCdCeGWBE/Ucdbm7CdE7Y9SeE4rb+X7HU+/UBonf+eSGN1runlJN7oltYgxOrxJJa4NGIdyagLLI3TH2HX6QLAXHaJTO6XZiDh6eZv+cw+effgnhOeTkWJHjqBzPMUQOhI7AlQoHH0kEhHQSiVElcqOQxhBJQ1Zv0Fk1TNcilM5QQmLxyISL9hyM55FaRTfNMXmG5w9R79R47VqXxY0cCRw66rN/P+h8mVxvIZUmtRBbQaIUmSNJsGircXHxTAWn6+LHEjcTvWF4GZmbknqatFcrkWuL0ClVJ6Ukt/DNGvcddpk/JGnk8NLrOReW6nSkC6WQRAishFwbXOHgIhGZwVduoS7zXBzXQSkXpRyULOqwHaHwlUvFD6mUQjzfpd7cIrEp1bEqTiAxWYyjU1avXuP1r1/n8VPjhEmHUKeEIiXPCp19jKAtRgknTuIduA/cCjrOsaYQFvlWCx8rPCAAERRZL4QVSOEglNvrl7anuKi/pr7txHqTh/JN93rH4N4gN3zTI9yvw+7nLXNT1PyCIirVxPDEDJ0c4rxom7TdbDExWuLB+w+x8PomK4tXEDom8F2SPKOdpOAGKDckSTLiOOmNptEkWZegFJBkHdK0hVIJjfom3RZUQkvg5HjKIKWm020jlMALPeqtNo1Om5GJKsp1ubW8xOULa7RjzcEZOHowInCAtIkvDYFbNDsQgBWFDFKIIjgkrUUai7IS0escYik6seZCkAuFFrLo9GIhTQxTU2NEviLu1BkbGePU8VGGAlhe11y61GDpZoMgnCYMphHCp9M05GkAOsLmLq6MilroXsBN9BVcMgdRBB2lMvihSxgF4Disb9bRRlCpjpDlFkcpWo11Xvj6M4QK7pufY3vjFuVA4TmWzfUib22lRLgV5o7fX3S0EA5uEIEuUlq+6+LJ3Xlte5zsN0lR73EB77TSb0y+7L7kncps7iVyfxMU00sAdge3aVMIFxzpQKnKoRNnSEREKxe4jkO8XWd+/yT7hiVf+qNPEkrLUK1KmlvqnYyOccikT2qKXKmvLK4oergpTyOcjDjbZnnlGisr1yhXIPANrswQtoPrZJjeVEypJJ0kIROK0ug4m806Vy5e4dZCmxJwaq7C4X2j+BLIE3xZJGaULerIlTXI3tZP50iKkUlWCLQo2kppITHCweBgUPTLWY0B5bjFmBxrGa4NMX90kkMHFBq4fDHh4vlNus2IUrAfk5YQpoqwNTAllCiD8dGZwOQGk2u0ydAmRusu2nbIbYfUtGlnTeqdbdpxQrk8iutUWFtpsr3ZYahSY3N9mWee/hxjow4z02XanTWkzPF9v2i4Yn208ajURjh+6j6QhRrFjcpkaYbVFllUndyGuxYAv/O1KP+/8S4jd/EtFhMmdzut0mtBfPR9340a3kesHYIgYm3pBmNBzkfeP8nn//Ai7Y0NRocqlGvDWLdEqkKsX8aLqpRLJSqRSzlQhCWHxHTxSopUt3nhxWdYWX6NUydcsB2UiEnTFq4yOI4kN5pU5xjl4pVrZE7EqxeXuHyxi7FwfBZOHxtluBRi4iaOyQikwKYaZYs6ZrUz0E7TzxWIXneSfhKhIHhPhCIKgQ+2F3B0ob6xhc4SKpGPK3JGqxUemJ9gbhjW6/Dyyx0uX9xCiTHidkA12ocraggTErg1TCbwlF/MFFMKx5U4rsDxLI5rcDwDTk4n79BKunS6GYePnqAcjbGyWCdUZcpByMVXLrB2K+WB+8sYvYkUTbK8jaM8KmWXNDWkWcD4/sNEB49AVuTfCcpkFJM/+2KUOy33HWcFOzvdg3jXkBvokdv22ijvzhzTVmOTDPYdpTr/ADIcKsb6moyKSnn42GHyFrz89afRcYvxySkqY9PYoIr1SpRqw4SlCFdoPDcnKnt0shZ+ycWKjHOvnGOjXuf+MxOkyTaCmDQpik1cX5IZTScDFdZQpSGW1rt841zMZh32hfDIySpzMxVk1iHvbONh8IRExwWxpaFH0oLg2L4Yo+gwY0WP2LDjvfTVe0YUhTSBp1hfbmGShKGyS9beQqZtzsyP8t4zw4TAworhpRcXqG9pOh1FKRwHXcLqAM8toXMI/JDAC/ADF89TeL7CDQRuAG5gkb5BhZKoWkYLQak8AjbEUxUO7z/K0tVrfPlzX2J2SvHoI/vYblwljHKyrEWWGcKoRDcBoYaYnDsBaqToNpwDSBzHR0iFsRprzE5YrNetvnci9HKPvSj/vYp3Dbn7Y2D6V+tijJHE2KIKy2QGUsXBEw9TnjzIdrPL+FCVsjL4usWDc4oXn36K8y+/RJ4bvFKF2Aq244wcQZImbG+ukXaaKGlJ8hSDRTqWRien03UYGx0pZn31mj/kWiCli7aKzHrIoEozVZy7uMy1pSJ5c+wgnDgyRiVwybtNbJYVrXQL83T7bLudD9u3XIb+BMvdpWOROxQ9iy9tEXT0hCSLwUUTCIPubEFSZ2akzP3zY8zPFvrqa9c3uHzpOnlmSJOcuBvvrHOFpXDHtUb33XKdonVxm5uEnBQ8i1/2MUKwtLhCqxEzOTKNKzy++Cef5eK5qzx8dpipiRJZ2sD3MqS0tOKEVHsghhiemGNiZq73farCcuMIxwuElE6hirNvtN5F4fhur7VdccS9h3cNuZUqppUYU8xT3nHRe3JS6zhgPYYOnGJ67jSuHyIxiKSN6G7w5z5UprsFX/7cU1y5cpHcWDpJTr3VIUkzWq0m9fVVTNYhz1KMhVY3Rrk+I8MjaJ0TxxkWBys8PK9orZtZH6PK4NbQaoiF1Yxnz7VodmByGI4eihgfCrBpDHlK4DlgBWlWjPUtfJFCs12422InXWt7zJfkvSHzBaH3Vjgpa1EG0CmjZSg5Ftvdxs3bBKaNr7eZHVY8eKrMRBXqCbz40gsIYVhZu8XW1mox3SWLcRQkWUyWJkUnmyQlTTOyNCPNUpI8I8lTulmHdtzB9T2Wl1eQVlGLanzj6af4yuefY6wGJ49W2d5cwvcAm1KpRnSTjHoTqiNzzM0/RDQyAyhwIoz06GvQrChSWrvLrj72lGpyb1tteBeRu4DAWluUbO6RFTmOQjquwK9CeZzR/UepjEyytVknbrcIlOU9Z49T9iSvvPgNlpeuFZM3s5wsz/A9F52lpFmXSqlEluZYI2m3Yhw3ZGp2CgOsb3bR+FgZ4YYjtHOXWIfkVDFqGO0MsbypOH+5qLgaGYGx0RKuI0niNtZafC/EWkmSgeMHGOFiZDHoIOtNEDW9VJUWomgwQeGOy56IxWoNtujALfvtmlOYGFOUfMi62wQyI1IZprVBSSbMHx5jbKywdxevXMINNJsbi6TpNlKkdDvbeJ7EkQahehVzUqKkLEo0lVuIWaQiy1I26+sM14YwRjMxOkzF8/jK5z7L8o3XeeyBKcaqFRavLlIOIUmhXKuRWUW9bRgam2PyyBkIaoXFdkMhpVuM+bWQ5v2pIP2oPey0oRVmj/XuW+17c9H9LiN30fHDcdzbruoCgXR8Ot0c7VYZPnyKiX2Hi1G71uBJwdbaGh/9oeNsr8NTn/0KywsXODA7RbUU8OJL3+DgwX1UqxXiuIuQCqVCcu2QaZdcO7Q60M08SrX9aDWECCYJhw8ioglKo3MEtYNcu9nhuXMLtIrhJzzw8CFGxkcwQuCXyvilKqlVxMZBq4hYe7QSRaMDxikj/QpaeGznkvXEkFoIqxVcV1GrFGpbncH4yBDlMKLbSsgSgyN7ZeSZIe9qZG7wRY5nu8hsG9IGwzXBY08cKAJvLU073uL1Ky/wW7/zH7h24zwHDo6RpttkaQeJwXOLrixpltNpp8SxQTlBr4VRxqGD+9lcX2FmYgSZJ6zceI2nnzrHSLXEE48cQydbVCvQaBTHIhceqQ0xzhDlYw/iHL4P8ATCFQgHlCek9FDSxVEeck8a7HYi7w2P35vueB/3TuHIW8TtI4P3frkK4YTCKokzPGP3HbuP5s3XaK28htYdtOMzOVrj+z64n//3ky9x5MwV7jvzAMvX6hycmeTW0gKz4+MkaU63bclyAZmhpXLiVCA9gXGGSGUN6bq8cvUGt26tsbIakwsPrzbCyrZmaSWmWoGpiYgjJ49TVi263W1SDZ4b4EY+StQwWUaqc6IoJM3BKw1jZEiuLW5pA7/cQoRltFFst9q02pa5AzA2MczKWp3VxVsc2TfE1HiFG1cWUEDoWTy3OCniGNI0Q6kct+RQKSuOHK1y/wM3uHYDNhsZB49WuXrtG/zSL/5rfuJv/U2O3neSy9cukeYGaw1COQRuiB/5WKNodXJwoVSJ2FxdZqhSY3v1FvefmeEf/5+/Qmv1Eh/98/dTCyQbS+u4EpQPjuewutVB+0McOvwwY3P3g6oVum+x20alaDVdKBPNHiKLO9fVhTBgNxBhLbzBhf/Ox7uO3G8GCzhuhDYpSpUZPfkwhzZv8MLyVTrbW0xMD5F2Ux65b4anX1riS3/w6xw7OsTps++hsb5Gfa1JVhnGcT2i0EEJn2Zjg42NOstr2yxvWp567hJfzXJEriHvsG92H6cfO0GGy3PnzvPsy9e52YW5KY8nPvQkzdwSxylZnKGzFCUNritwpUAKgcFDd3IyLVFxQqwTUitpZSk4ltVmTGe7xeHpMbpZztomNNopU6ND+JVhVhtdpOfglaPeFMyMTOYFJdxeCSuC3Bra3QZ5kPHDHz3Ov/q5C3Q7sL6lmZitcfnqOX7t136R/+5//p84fOgAa/VNWq0W1kqU8nD9EiZXdOI2rpAEyuHmrQXGhyxnjx/mt3/l5/j0J3+F7zozyaOnJ+nWr5O2O3gujIyV6GiP5bWY4dmTzD3xfZQPHCsCisrB7gkV7pUoyp2f7LHUgjv27W33Hq+BAbl3YHuDhdqJtrl0KY0fYey+Rxk7/wI3r58nMaoITScZP/6Dp/i5Xz7H7/7ir/Gef3aQjk0JfId2N2GkMozpxgSBi/ZDut02Y5MHOf3wexirlmhuNfClx8n5g5w9c4Zjx06icZn56rOYyud59qVLSNFlrdnl1sLreDRwVdHyV+cJNjNIUeSllePRjVOscPHCMokG6QTU0wRKilv1LjevLxLHXQ7MV9lY3eYPP3+eJ584zoF9R9lYucH11Sazk0Nk8TatNMPk4DiSKCwRegEYSTfLaaUJTTQH5g7x8CNb/NGn1zj/epvhiTJHj+5ncWGB//jLv8xf/1t/A2UFQ0NDWCOJU2i2ugh8orCC42qSZp3xcoVIGlrrF/npf/rTzAzDRz50ApU3aGws4SuFKxVSVIkzQaYcJufuZ/j4WSiNYNKiOcbtxQX9e/YNz+xabrnHYot70mL3Iew7tV7tz4I3SQfdfUd71/sWh7YVxGluIxGLyIutbV5l45lPce7pT7G9voTnCHLl4A/V+MJzG3z2mUUee/Jh/vpP/gTrjYTMCGb3H+LVS9eIyjWUAJunOBQDCkaGKrSb2wxXa8xOz+Ipr7DMmSbLLddvLPKVp7/KhUuXMXmLQ9MhUrTReYZE4DkSz3HAWtIsJUs1QkhcPySqDmFxCEtVcgO5AT8o8cqLL1B1BU8+/jBxe5Mvfu55WvVFHjkzy6njh7BZi3ZzE/IurgJX7Qp8rDHoTJMZQ0fAthJsZ5b5Yyf46Z95jouXGqgAPvThxxiZmuALX/k6h+dPcPahUzz48MOMT07TTTT1rRbGuIwMjeHJnKy7zv7pETqNdf7B3/9HNJZu8Zd+8DjzU5LWrSt4pslQOcBYRTN3aVKmeuAMZz70owyffJxMDWO1JzwnuuOr330k7npiWHZbcPXx5hKX73S8iy33HXV7gNZYz3OEY3103Eb5w4ydfZwDW6s8/9QaWbfJyFBEvLXGhx+p0twc4lMf+yqnT+3jkSe/nyu3tuhqg+87BK7GGktscqxSOI7Leiel3kpp2YSGXmOoNozveeg8o9Nuk0nDkRNHOH7fcSYnh5mcrJBmbTqdDhhLFASUogApFGmaE3e7dDoJnu9TGRpBKAfXC/CCEIRia6vBzNw8D508yfhwFS/yOXb2q/zWr/8iT7/2GhuJy4HZcdKuohQOEbgega8QGLIkIYlj8rxItakwJKqUWLu5znbd54NPzlDf7vC16xn+U1f48PePMDE6yyc+/nmSvEtteJwwquAFJTzfI0mg022jPIexyig2jvnkb3+MZ566xD/4eyc5e8rj6gsv46VtZqbLkCsS47OxmeJPjHHioQ8yfOQBUhkSI3EdH7ung0qBP91Q9bLxhTKvt/9uUfC9h3cxud8IpRBWQGYEea7wlYMammLfibMs3LhEY+kC3VaD6ckRMpNz+kDGyqrlN3/9jxk/dJRw9BCNVkyaxgjTQUkHa51iHq4XYIVHOByiopBUedRzQ9zYoNPYwpFQijymw3E8pYiqZc5duQJKEgYhIFje3iZP1nFcl2qpShhGtJCo3EHHsph2st3E81OsFNy4scji8ibzJ302b25i0gT8MR750A/T1C6f/PI3iLzrHD/qkicJaZpjtaEcwdTEGJMTE0SlEYyxxMZSyqvsn5ngS194nonpw7j+BIdKm2xvbvPUly7wxAcf4G//jUNMHZylWq2SZhnK1QRhgOtJTG4phQGhgt/7zV/n53/mt/mvf3SY4UqHWzdWCdyUkZKLtDlZWlTNRVGN2YOnGT3+EETjbGeGXEhqjovttUIq8KflrEVvTONuiK0XgnuTYVP3Bt7FbjnsnhCFW97tqbElIPMYR9et63WxzQUaL36BS1//NBvXX+HA1DBbjQa3GgkNVeNPvrHAmi7z3/+jf05QHiJvrmLTbRAKLX0yHDKryHEQ0scKSRSVKJciTBLTrm8gdEKgLDpuoeMu0vdpZhZ8jygsE4UhnuMhDOhck+cGrOTggYNYC2EpxFpLq9PB8VyU67C0tMTi9SXKYZWHHjyL1Rmb68tMjtWoVQIuX3iJ1y+8iLQp21vrxJ0m9Y011tZvsbm+QbtdjMl1VKFfTZqWatXBUTVaXXj0vR/i8PwZSrUxRiYnqY3X8EoeXd0l0TG5zjCAUB5SeviOT2jg/NNf4Wf++T+m7Of81N/5MHnzFa6/tsRjp0YZcjW3rtSJ/CrGnaJ24GGOvPfDcPoxCCfYwqVLQBlPlHdssLnjO77zROjLdorYyt7YucPutO17Dfem5X7Ll+J+F8veCwwkqbaeI0Tg+FgTkDS38UvjDD3wBOWla9Q3VtnsJDQ7KeVSmZmZAyysS5753et8+jf/H/73f/ovuXY9ZXGpheN6BG6AMgKbaYTQRGUHnVvydBsCgassgS8RRhG6CutLRLmECjwWX7/CxfPXuXVrmYmxSR579DFOzp+gXt/m6a89xTPPPMvszAwWQeD7CKDVLZRffhCwvLxMpx3zwH0P8fHf/T0qlYDR4Rqtxhqd9hbVio+yGcLkfP9HvoeDB/YxVC1x4/o1/uCT/4mvfe1pqkMVnvyuJzk2N8/60ia+W2a4Nk25PMLY1EEcNyLRljhL6bQ7ZDpGuOA6CqUsic5JkxShBGO1YW6df5mP/9L/TVVkfPgDJ8ibq5Al3H+igs6arDdS/EpEoivgVtl//AE4/iDIEp1Eg1tBSJ98J3/VF6HsbZNy58nQf07e9q3f67g3yP2WyXy3wMluZDWQ4HlK9EfJCDcUSo1bVAolnxN/4ae4tp6ycP1Vpmf2Q9pha3WdB/f7RB8p89JTL/Ovfuov8Vf/l3/C8fvfS73ZwsWQdjtkSYdqOaBcCtmu15FSkKSrDI+OkZWrbGzWCaMyQanCZqNOuVLi/O//LjcWrxKEEVeurrBv3xCPvfd+6q0uSb5FddSlm9d57rlvMLt/H1EYcfnKVcq1GvefOYN1LLfWltDfSJmZnubrzz9FJfIplz3WV5cYGa4yd+Ag2/U6bjRMV7sM+SN89cU/5tzVRcqT08R5iytri/zAj/0Vjj8ywtrqNhMjU7Ra26zVt6gpTRB6SE9TKvs029tkiSZyKwgnIHAVw6MTpEby3Ne+wGd+9d8R31zkRz84zPRIRnv1Jo7K0KFHSwd43jhx6tGlwtmHvxvvvkchHAITImVJKOHig/V2wtx9Yr8ZXQspy53JMrnnp/cq7g1y/2ehPzRGFHVSO5o9C0IhVCTAAelY/Crf9Zf+Hl/6xH/kha9/jmEvZ3rIZ9iLmThZZca2+MMvrfGJ6V/i4Af+K8anDhE6BpMkOFlCZ2ObzmpaTP0UgixPMYGLwaXTbtJJMyqimMe13W2xvHKDuLuF5+W0mxusrl6n1V5neDjg1OnDzJ+cY2h4hFS3er3XPObELGfOPsiHvud7uHVrmReffZEzJ88wMz3Jb/x6h8bWGqWSi+dPcPrUKb7vez/C2uoGWjpsdzVys8PlGytstRLGJiq0NussrK3RyDLCKKIlEqqOR+b56MAlDwRt3aXZqBP6AUHokzQa6CRBW2h3EwLpsra5xq/8wm/yymee5x/+5ZDTB11y00E6Bj+sofFoxAlJR1IenubgfWcZO/4gjE6DiECFwlFBUaraG88ldvxpwRud6zda8neZHHNA7gK74oeiJlLsKbfql/grrE0pTRzm8Q9+hPb6Mus3XsVKn27SJm+2ODY/RF0n/MK/+zLv3YQf+bEfxCifOO4W0tTUUt9qEpXKaAteGCG6Am1zmt2MpNktGinonNcvnae+sUYYKUwWI2zO5voyC9deZ37+BIcOzlKr1lCOT63ss7CwhLEQ+BGH9k9z+sQRIk+yvrDI6dPHCXyfcslnfa1Ls9VC65RKrcyhw3PUhsaoN9oEpSrLK+vcXFkjzgxWeQjXo92NuXz1Kkfnxkk6Hda31tHGIrwIHVTJ0pSOykmsoiIChmeHef3CeWpRiYceOcvn//AT/F//7D/Q3oz5uz9xmvmDmwhSsiTD8QI8v0oztsTaomWZiblTnPrAh5FDM+BGFBdXFymKnng2t721/J9md+9lm/zW8G67mH0TvLnbDlIIobCtOtX5kzz+fT/A6Pg0G62E3CnTlRGpGuLU/RN83xMzvP70eT7+C/+e9sqrzExU6aYZxi0xeeQMHXeEbTWErs7Sdmq0RYB1S0XKCYsnNNdef42k3aZSKiGRlMKItNvl5sICcadN3NombrXQ3Q5kadGc0GhsmqC7bUzcwdEpjtQk3QZZ0saaFCk1qtc6LNOaThzTjmNAMjE5xaWrV1m6uYJyfCyKICxjreTciy/h2gxPatrtbZqtFp0cmrlDi4i8MoUuT7CWCq5vNBibnmF0rMyf/O7H+Hc/8/N0Fy/zEx8+wPc/PkurGdPuahItSIzDRjtlq6sJhqY4cfYxjj/8BPLAPFTGC3mpsaDtjn12xB6jPcCbYmC598Lu/LcH/VOqCLwJJ4A0YfTQPPc//kEufv2LbDfXiSpTpEqTpRk//sMHkL93hS9/6XVU2uUHfrzK+OFDxKpKKkOCkYh2sw3RON0sIck11g0JrMFVila7xcKVS4yNjDAzPcPiwhKBJxAGGpt1knaH5ladbrNNrTqEMJrx4RoISXO7xfbGKpvLN4m3G72AWYaSOY5r8XyJ40mQBqkkVgiMFYWa0/V4/oWX8fwS952eZ6Nxi7S1ie/6vPrqq7S/u04p8ImNxEgHvIC2FrRTU2jfFUjhUHYNrpfzuU9/in/7L36WMIWf/NHjPHQcbl16FZPnWC9A+SGtWLPdzXDK4xw6dpZT7/kg3txJIAQZAT5YgbEGYSxSimLm2D2Q5Hm7MbDct8HesfXRry+SEFTpbmzjhFWO/8BHOftd30fH+GzGitW2wLoR64vL/Dc/OM1f/5E5zn1lkZ//Fz/P1deuoNMOCzdvoXHJrEsmfBLr0k4M2kqCKELrnFuLS6ytrPDQQw9z8uRpwiACI0iTnHq9QdxNCDwfJQWN+hat7W3iTpek3aHVqFPfWKW+vkpra4tucxuBJtcx3bhFs9WgsV1nu7VNN4nJjUEoRVSusri0wosvnee++x/kR/7CX2R4eJzNegvl+DS3W6yu3KIU+pTCCOW5KNcH5WEdDyMlOZYwDBAy51d+8Rf4N//qZzk6o/i7P3GQY+Md6tdexkk3KZXKWKeEFiG5iHDKE+w7eoajD30X3pH7IRgF7YMIQQQCJxRWKjAGYQyOtDgD0/1NMSD3DvplgbzJcq3nECKQfpksFWAdps48yiPf/UOE4we4strCr02g04TGrWU+8NA4/+NPzuNmHf7ZP/qXfOrjv8WIL1hbeJ28uYVjEsqBwhUWKSxRFBHHCVevXSe3kiOHjzE5tQ8vrGCEQzfJWV7dZHl1A8+LqJSHGR2dIArKaANaG8IgYmJ8kqnJGUaGR4miCCk0rgNR6FEpR1SrZSrlMmEYIZWD4/qMjk/w0rlX2Wq0OHxknsOHjxFFVXQOrhdQLlVYWVlFOQ7a5rSbW6Rxk8AxTAwHzI5FTFRgc+k1/tef+jv8/q9/jCcfHufHPnKSA6MuVSemFmgcLLkWrNVjGl1DWJviwPxZTj78ASrHHwJ/FJt74FYFRAI8kB7K8QGL1RmYDKweWO9vgoFbvoP+etvsedy/7WdGHay1wh+ZIW2u2ta1W/jVgFPf/1H2HTxKYj1ubq6wr1yjtXaFLNecmjvJ3/mrNX7jj57lsx/7NMuLN3jiwz+EE1YIukMMj46RO5oszvBkxFqzxcLiTYJShQuXFihv1Nna7mCVj3AU9XqHGwvLROEQ0nVIE027m9Np57iOA8LH9co4bkRuJd04odGoY2ROEnfROkMYyPKMbrfLdrNJu2Wo1QSvvPIaQVBiafEmn/rUH7Nya5lquQIGtLFcvrrAw+9J0ZnGpF082yWiSdbaZGvlJudf+BpPfeYz1C8v8r7Tikfmp+huXKchOxw6PEk7j7ix3ECNGOodzdTICIdPPczEoVOUD98H3hBGu2gRCEGZ/gQvQXGiCikgL9bfOLIX9BwEzt4MA3LvxV3Ok34WvN/7e2Ptlo1KIVFlHK9Sw8Yt8vUNwuFZPvpXf5Lf/vc/S7O7xXBtjE67xdXLr1ManeEv/+D7efaVqzzzygX+/fMX+It/7c9TOTjCqAzYtk224iY6dmg06txaXkMon9/53d9ndGKUVqvF/n37iKISrXabjXqbOLO4uSDpZhjhUKoME0URVhuCoIKQHhYHxwmYnJwiCB1c1yHLDdpmaGPxgojR0UlcJ2Hx5jJXr17H8wI+//kv8nufWKFckuw/MErSabO5VkcnDs1Wh6gUMD4UMD4SgGlw/vxz/NF/+gRf+OMXGC9H/PT/9gOURMzNi+eYmxmh5lW5eGkFKQQHjk2z0IwIqz77jpzh0GMfxBk7AKJUtEaWocish0WQ6qIdu+8UgXEhBShRDBA0BtTAN//TMCD3Dvaus9+oOC5shGFkdLLoCYABq6xwQpzaBFiNS86P//1/yGf+zf/B+mKdUjBE4LqQd/FNhzP7IvYPHSTR8Me/8Ud89jd+j7/y3/4wDzz+XkanqnTyjKXFBa4v3OQH/8KPcOL0KaRSbNW3+PxnPkun02L//v2sbzRoxzkHD08ReD7SLdz5bqNDmqZoGeBEQ7TT60XNdy5xnQBHBQR+iHAUWatLnmm0tiSZJk8yLlx4ne/90Pfw6CMPokSCyVt89enPcO7c8xw5doJW23Lh9df47g+8n8PTI7z83Jf45Md+jVeffx2VZPz5h3wef2gOtXqeJIsZ9zVZu8lyvUsqMlA+3W2IRvfzwAPvZ/y+B3CGpiBT4DhYAoGIilA+vSnLcs+4HtsTrAhxuzhtgLtiQO4d9MMPby5MtEik8ik6iWmwTnG2OU5vDahxax7v/6G/zNq5WS6de55bt5YoBYqp8WHGJ6q0ozabjTp/+0fm+MQfvMrH/+3v8+XPfJGHPvAgpx75LsaHAo4eO8KxI0c5sO8Aru8x0Rrn+Wee48aNG9y4vkCea+47dQaBQ32rRZZaOp2sGJOkDa1ORruTI1SIQbK+scl2c4u1lXVuLq4UFTLKwxiF6/o4MuOLX/wSeZJx5NAhHn/0URxiNtau89qLX6ax1mRBXaI0MkMSN1lZfJWvvPwMn/r4F7n+ygJHJuD97wk4un8c167Q7bYRCMKwhHV82srDiIhOLqjU9nHqoScZnz8DE4dAhkAAsoSVAaZXVw+9PIXYExjqu+EDQr8lDMh9B+6c1PzGn9MrEZRY4SCkFBhtrZCAg8gM5VOPUR4fRZXGkC88Q3NzkXY7RmZdfJ0y6lumZl3skzNcvtni2tYWn/3EZ/md375APTccPlXmez/wOFvbTUrlCt7EBE888jDjtSpxktDpxozWatTKZdJOwvFjx6k3mijHwRpLuVwjzy1RVEFKn4mxWXIdc9/Js/hBhU6W4AUlxsemSWKNIzxq5RrvfeRRJkdG6NS3IG8SKcuTjz7ESKjZbG3ztRcu8Zu/+jF+pW5xujc4Og5/7YcPcHp/QGQ2iJvLYHOGXR+jfDq5ZbPZoWV9KuNznDhympmjD1I9cBqqE+CUwShQEYhQCBwybcmstb4jxd6oR+FY7Yl/3Jsl2N9S3BtVYd8yWOw3DcH2ywxN0afL9IbMYxHGImxqkQnIDnZ7jebV89x66Wmun3+WeHOJsqOplHzqW1uMT00QjUyw1Eh59sIWX31lg4tLHYanJB/4nh/m+OkDHJyb4/iJ++i0OyQIMm1ZvnGDoZExhkfGcB2Pq9dusN1sUapUyTOD47jsO3CArXqdz33m0/zA9343rg9J2qXdbdNJEgwSz49wnAiJy1BpmJWlmxzZN8toNcQkGyi7xeL1l3nqqa/wzDcu8+Jr17EaZqohj56a4YFDinG3i4q7BLaLL2PSzGCdgK4N2IwVG6mLN7KPkw89wcn3fQ9MHi7SXKoE2mJywAmQbkkgPJqpJrPWln1npylS0aW1/xXpXitXueO+D3B3DMi9B8Wq+/bjId5A9n41sN2dP7an+T1Wg25b4ejCp7Tb2Gvnuf7CUyxdeIHm2gI2aZJ02szsmyLNodHN8apD5J7PtZtbvPzaCs+/ssHEvlEmZqY4e3aew3P7OX72LAcOHSZrdzHCJcstxkqEcugmKaNjk+Q5rKyt4QUBzWabP/jDP+KJ9z2O6zpMzU4hHEGmc/wwxFjJdr2D7/iUvBI2S1BZwurCJc49/zWuXrzE1sZlNtYusN2EfYcm2D/rceLQJNO1ErS2aNxcImu2CB1L4Au0VXSMQ6qqeEOzjB48zdD8g0wdPY03MosmQokQhCswFpMbi3KFdHwQDqm2GCye2m1LvGO52T3Wt9WNDHBXDMjdw91mTxROoNm5vxN0u+OY7X1Y3M2xpNaaGClyJCm0VmktXmLx3HMsX7/I5vIivgeNzXWSOGZ0bJRytQZKYhAsLq/xpWc32Wq1QGRoC5OTUxw+cpzx6Qlm9k8SlSqUKjWGRkbJtGB0fArh+Gw2tilFZYwVfOHLX+H0mUfRVjE6PkI37dJo1hFS0k0yGpsNdJzz2rlXMUmX1upNbrz+AotXriFzwZFDI5w8JpmdVkxOjOA7LjaL2d7cROmMseEaoeexvlpnbauDX67hVSYYnj3KzLEH2Xf/+2ByHohIul10Kohq46LfvvCN2aw72Gq4vc/ZnfsPyP2mGJB7D4qxeQV6q+o7mu2ZNxB7Nw9ewNIbk0tGnnasi8Hzevlz28IsXaW+dZMvfOqTJI1lKjJjKFSQtVlZuk7cbnBg/34mpmZpWsVKvcPSrTUuX93k2o0WG1sZCAir4AXwwIOPUR4aIbNQrtRQXghSMj4xjuuFvHj+MqOTR1FhmXKlRDftsLaxyvrGBktLN1m4tkDS6lDyA1SW4SnNsJtxfH+VB09PMzXmYrMGNtmgvnodm2dIAZ5fDK6PU0OOix+NIvwhtFPi8Kn3sP/kgwRTRyAcI7ceCp/cKJFaB88Pdo5XMTObXvfVvNdmmN1oOJK7KskHpP6mGJB7D3ox8B1XsEiI9S13j/bGFmejZXfP/tqvdz5mFrSwiJ06YoOksOCSxGITEIrlFz/Lxa99nvrSRWR7lcC0iWQKWQcrXVJ/iEyGROUq5UqVTpyysr7BVr3Ida+sN3j5tS5G2B1tR6rBDWB4xCfOJJdvdKlN7sN4JZrbDeI8xg99JibHmD8+z5FDhxkbGuHxhx7mwdOnYGRG5Fe+Yp/6/V/lxpXn6DQW8GWTE/urePk29c0uKMvI9CzaKXNjtUkjUYztP8n++YcZmTnCzNwp1Pgc4BM3YzqJJohqIogqO8fYUAz+cCkIrowulGdG98aWOrvfguiN8xN7DjsDfn8zDMi9B/3RcH3s9sXs2/M9ltvSy7fKO1xFSTfP0QKEVOzGfDWWFKFzlOlaV6SI7haElnjxIq997pMsXn4J38aYpIWrHEpDQ2w2WjSaTTzPx3VdgiBgeGgErKXV6uJ5Dkmq0VZQb8esNTpo6SPdgBu3NrjVEPzN/+GfMH34JEEQMjY1RlSqit1LGeTdjnUkhepLZjz727/Eq8/8CdNjHiWny+bKZSqhISDDUZJ2JllvJLS1z/DsUU6ceZxD978XNXUY3GqhCc8dEg2OGwihfECQ5IbMWHxPYS1kWVFs4qlebMPs0H7PMe3P6OyRew+jB+T+0zFIhe1Bv+ntG5d08s4nejnXu7fXCxznrut3gQJlESoSAmUpSxAZwYHT3P/RGQ4uL3D96kWuXrrA1vJ15Noq3e0VPNfBcTwMCRJD5Ch0p8Wt61eZHHaoBj5xmlPCZbQWEKsIQkXoRchbmrmDI8zMzwlJP2mcY9EYq1FCIZUli1u4rg9bt5AqwTiGxeWbjFcc/NIw682Yje2E2sgEY5P7mD99iInpOSoTB/CGppDRCFAGSgLrgKPwHAFC7fQvcxxJ3x4LAZ7Lbtra9j2gO8yyEMVkEfbsO8BbwoDce/DNU6dvknoRb3y4u0q8s8qs/1tcoQXWWIGQLqpWpVqe4cD0cSrz70M3bpItv0zz5ms0tzaJ2y06jQ0665vo9iqjPswMafxMU3YTnLyYwe2rDp5NMQhKwuJJg6N6VVRW7Pwpxgqslb05vhKnUgKRkSUxrU6brUYT3W3hqxJl38Utj/Oe9zyKE40yNDLO+PgM/vAklEfACSmqrB0wTs+NFjurFdv7X/RaCcueUuCNV9G3dnwHeGsYkPvbgjfacFBIhDDWWm0yhFIo5TNcjRiqToE5iDk4Tr51gnxzje7WBo31ZW5eu8DGzcuopMNUrYpubWNswVEDSFNUmGEM0hqkFb3VhETY3hJiZyS9BSExRkOa4aDpdDSoKhOz80yUXY4f2UdlZBgbDlGemcc6JZQfFVVaMig24QqMKiyslLdFt28vnt2VAA3w9mNA7rcNb9Zv+faG+FIUvqnojbaxWLTWCK1w/AmcfSMwlVHOE8bSNmOXz3P1K3/CrWuv0MwsigQfiSHp2UYXbNGAXRpRzOO2slCC2b4/ofZk9QSWQCjHAZvZcPgAx06lHN53iNpwicrUGJTDYiKfiHq3DhgBRhZRPKuxWmOFQgbuXT/17hF54yiBAd4eDMj9tuFus593HX+t80IwIxzhSHcnj26twRisyHLIyuB5UFKQdBFlw1Awylwzo9lMqK9fpyIre6L8FqyLsAJhLY41KNO7nFi5u67tWXDRN6vCR7o+gPC8CtNBxZK0wJNFCXvahcRC5BeDwxHFhcL2lN+2N39LOsXtHR+7/6l3cttv2zEfYC8G5P6W48419t0suMSY3akXxkqkLMbaKCFRbiisLIFpW6wDuUU3EoQDsjpDNPcAtSvXWVtZx1MumdBokaPQhVW0FmkNihxli4G2iD392WEnrWQEaANZW+MogSMk0hkSqDKQg8ksWlLoRP0ecR2BVOy69woh1K43fuc4rt1fOcC3EQNyf8vR17rdib0mTeK6EmstRtuimisHKSXKKUgilIN1lRBCgdUYV1uhDNLxUKOHGJ6ZR129RJquE0sNMsbaFIRFCI0kQ9kUhQSbg8h3/z4hoXdxQYCxliTNrXaFEFIhZW8wtnWL9XQUgep9LtmLXsvehM2e0KTffu72ao8+3g0jAN55GJD7bcOd0fHbN2sFQvT6DVjQhTuOzSyOKiLN1vUwOQilcIfHBNZgTYwKR+zk8TMcaa5x+fnPkcgUJVwEGiEyrDB9wQxCOAiRgshs4Zf38sY91Ze1AqEE1WFfWHochqKiNbXY3FjhSCGkC0oUxTJiV/dteylpo4uVtONym1sudvd8ew/3AG/AgNzfdhSne54ZpBQoJVBOETsHbvPmpYJ6J7PKUSJ0JFZbyMH1Ivy545yiy+vnnyWmjisUQgqENQXJpUCIDIEDIiu2wraCUEUrVSsQwsViaXcNUko8R+w0H0yxGGtxkbhSFjG0O5xrKwulmRXFUAfbS0YPXPD/8hjUzL1tuFPGcjtcV6L6TfXvXKb37mqgXHGFH8pCsukoRBCA9ASujzh4iAeeeD+NJKelc4yraHZTUqMJS5IkTeh0BcrRQA4yB5kBiUXEIFNA47iGKFR4frGUNhTpaq/kEA6Fwik5WLnbQnLvBkX2SzmgnLtQul+HbfuBvAHtv10YkPttxx2sfYsQFLnrPhUMBdlzBBoFuAg3ZHhqltkj83S0pZPnlIYihGPoxl2ikoeQFit75BYZiCK2LsitJLeSFEFe/ByNwexclvrRg/7vHqycv7MwIPfbhj/D5Oe77SZ2lW57lXMGgcEBHIRwqe0/zMmH3gN+RDu1+OUqRnk0uxrXDxAOPWu5911sL3peELq4ZBSXjX6Ri0X3/hk0dmcW6p++7XVB+nXXb/0wDPCtxYDc3za8SfJ37+M771sDtuj1vSt9AY1C4wtEgByZYvj4WSYPnQCvTDuFVCsyI8l1L6iNy+4k6v7avl/K2luj79nYuTXYXjnNXhKrPVu/LFb07Hv/AnGbrR/E0v6LYBBQe9twp5qj7+TeMTz2rqTuP5GDNQhclFA7dCno6KOIijV0zXL/wx/glW6blYULBNKjEgZsNppIGaEJAJ9CmVZEuwWmELsIhcT09N47PWboi036qjKJ7RWw9gs9+nf2xhb2Ou5vkuwe4NuGAbnfFtxFpgW8tfX3HoabXvMCqZBSFS276V8mFJZICFKLzRi9771ML99i6cYimXGQXkSz3cTgY2wENhSY/nAFWfR96+nMpTU9wheE7k1F25PMK8gtjNjz0WzhWYjdv+j29N+fYVkywNuCAbnfFuwNg92N4Htv7/ZyUQhPTFEA0n/Hfk3GbqDLQ9kA0hjKs+w78Qirl6+ydvMKWiukHEKbCGsisF5PW94Tohjbu3CI4nfI3fzVbpPnvmi0T3t6zSoAqwti30bw/mfqX0T6f3lfXDug+7cTgzX3txx7feu7ncp3Bp3utuk993tpJN4YwLIIsEUjf5tCuO84R8+8D9cbpdlRVIdmyXUA1u+lo/qacElRXOL0Hvdv+8UlxSZ7/wT9FNadfx89Yt+Z9ntjbu8tXNIG+BZjQO5vOfZGyvZSsX+o38oh75tQCUre9hK5ZyvgghsJ0RUQjFI9eoZobD8tHUA0SmydngsPOxWf2B2uF9cP0dON9rY90XVxm3u9l5p7heT9mH7Ru32v5nyvRm0QOf/2YkDutwX9E/0/YxMKHAWuBMdilMWI299dANrkBWurI9A1hPuPc/rP/RiV6cO8cn2N3AkxyqJt8ZYaTZZrjDVoq8m13ttZYvcX3PlQUMhO5Z5NOBSReJciYOdBL013W2S+R+oBt7+9GKy53zbc7br5Z7HeRdS6LynpO/l38lBJt8cYRyBDi5S45VGGZw9TurXOwvV1cmuw5MWrhQVpC2m56b8zb411O/sMbMJ3Agbf0jsYopff3u3Cat/o6AuByUyxDHZ9wKFSHuHY8dNMHThCnOlChNIPzAmBUkXll5ADO3ovY0DudzT6ZN5L8gI743UEpHGKMQJUILAOqlRj8shJjs6fwvFL/bcqdt/TAkkIcdvjAe4tDNzy7xCIHtH3ZpL7D7QR1uIWNaS5FgjfMjzD+NxJRidmQXpv6nYPyH3vYkDudzr6i21bRKTEnmKSPrmV8oQQRdNg22uDJJxQeLUJO71vDtcNUKr4qo0xA0K/SzBwy9/J2JscvtvWg3LcYkq9FVirsMYRIFFOyPD4DK4foFQRijPGcOcgisFginsTA3K/o9GzsHdry9a7bzUI2WtQaEAov2iRhIsQAdKNcDx/x1obY9Baf1s/xQD/ZTAg9zsa/TzxHpLvhe1ltnoaFG3BKolwPUCg3JCR8Qm8INx5ySCI9u7BYFbYOxZFuWeBvmqs31aY29Wtdwji7lR5D/DuxCCg9o7GnTLWO57uoy9B7923sKNmswzqs96tGJD7HQv55ozciaD3Ht+tJnzPrgO8OzHw2t6hKMo65W69ldhD0zcz6GJgoQfYxcByv4NRrLhFT1NeaFR6fYR3d+pb8buyejC6592MAbnfodjNfu0SVGF7gXO7pxtKf+9d9Is1b1eiD/Buw4Dc71DsbS28l5oKdglOb8qfvRu5YTeUNgipvRsxIPc7GHeSe6e3wm09y+zt6/Ed9FQtO40KB+R+t2FA7ncw+l3IdvPWfRe9GNjbK8i+K7kLp1xies75AO8+DEQsAwxwj2KQChtggHsU/x/vuZxJFNT61wAAAABJRU5ErkJggg==";

  /**
   * Agrupa o banco de 500 questões por secção, uma única vez, para que
   * o sorteio de cada exame não tenha de percorrer o banco inteiro
   * repetidamente.
   */
  const QUESTIONS_BY_SECTION = (function () {
    const map = new Map();
    SECTIONS.forEach((section) => map.set(section.id, []));
    QUESTIONS.forEach((question) => map.get(question.section).push(question));
    return map;
  })();

  /** Acesso rápido a uma questão pelo seu id — usado para reconstruir
   *  a lista de questões de uma sessão de exame retomada após queda de
   *  rede ou recarregamento da página (guarda-se apenas a lista de ids,
   *  não o objecto inteiro de cada questão, para poupar espaço). */
  const QUESTIONS_BY_ID = (function () {
    const map = new Map();
    QUESTIONS.forEach((question) => map.set(question.id, question));
    return map;
  })();

  /**
   * Calcula quantas questões de cada secção entram num exame de
   * `total` questões, respeitando os pesos definidos em SECTIONS
   * (método do maior resto — continua a somar exactamente `total`
   * mesmo que os pesos não sejam múltiplos exactos do total).
   * @param {number} total
   * @returns {Map<number, number>} secção -> nº de questões
   */
  function computeQuestionsPerSection(total) {
    const exact = SECTIONS.map((section) => ({ id: section.id, value: (total * section.weight) / 100 }));
    const base = exact.map((item) => ({ id: item.id, count: Math.floor(item.value), remainder: item.value - Math.floor(item.value) }));
    const assigned = base.reduce((sum, item) => sum + item.count, 0);
    const missing = total - assigned;
    const byRemainderDesc = base.slice().sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < missing; i++) {
      byRemainderDesc[i % byRemainderDesc.length].count += 1;
    }
    const result = new Map();
    base.forEach((item) => result.set(item.id, item.count));
    return result;
  }

  /**
   * Sorteia as questões de UM exame: para cada secção, embaralha as
   * suas questões (com a semente dada) e retira a quota proporcional
   * ao peso da secção; no fim, embaralha a ordem final das questões
   * seleccionadas. Como a semente inclui sempre a hora exacta do
   * pedido (ver actionBeginExamSession), cada candidato recebe um
   * conjunto de questões diferente -- mesmo dois candidatos com o
   * mesmo nome receberiam provas distintas.
   * @param {number} seed
   * @returns {Object[]} lista de questões deste exame
   */
  function selectExamQuestions(seed) {
    const perSection = computeQuestionsPerSection(CONFIG.QUESTIONS_PER_EXAM);
    let selected = [];
    SECTIONS.forEach((section) => {
      const pool = QUESTIONS_BY_SECTION.get(section.id) || [];
      const count = Math.min(perSection.get(section.id) || 0, pool.length);
      const shuffledPool = shuffleDeterministic(pool, seed + section.id * 97);
      selected = selected.concat(shuffledPool.slice(0, count));
    });
    return shuffleDeterministic(selected, seed + 13);
  }


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

  /**
   * PERSISTÊNCIA DA SESSÃO DE EXAME EM CURSO ("retomar exame")
   * -----------------------------------------------------------------
   * Permite que, se a rede do candidato cair ou a página for
   * recarregada a meio do exame, ao reabrir a plataforma esta volte
   * automaticamente à MESMA questão em que ficou, com o MESMO tempo
   * restante — em vez de o obrigar a recomeçar do ecrã inicial.
   *
   * Funciona apenas quando a plataforma corre dentro do Claude (usa o
   * armazenamento pessoal do Claude, `window.storage`); não há
   * equivalente para quando a plataforma é usada através do backend
   * externo (Google Sheets), por não haver, nesse modo, um mecanismo
   * de armazenamento do lado do candidato disponível nesta aplicação.
   *
   * Nunca guarda mais tempo do que o realmente restante: em vez de
   * guardar uma contagem decrescente (que teria de ser sincronizada a
   * cada segundo), guarda-se o INSTANTE EXACTO em que o tempo da
   * questão actual termina (`questionDeadlineAt`). O tempo restante é
   * sempre recalculado a partir desse instante, pelo que fica
   * automaticamente correcto seja qual for o momento da interrupção.
   */
  const ExamProgress = (function () {
    const KEY = 'exam-progress';
    const hasClaudeStorage = (typeof window.storage !== 'undefined' && window.storage !== null);

    /** Grava (substituindo) o progresso actual do exame. Falhas são
     *  silenciosas e não interrompem o candidato — retomar é um
     *  conforto adicional, nunca um requisito para continuar a prova. */
    async function save(snapshot) {
      if (!hasClaudeStorage) return;
      try {
        await window.storage.set(KEY, JSON.stringify(snapshot), false);
      } catch (err) {
        console.error('Não foi possível guardar o progresso do exame para retoma.', err);
      }
    }

    /** Lê o progresso guardado, se existir. @returns {Object|null} */
    async function load() {
      if (!hasClaudeStorage) return null;
      try {
        const record = await window.storage.get(KEY, false);
        return record && record.value ? JSON.parse(record.value) : null;
      } catch (err) {
        return null; // sem sessão guardada (ou ilegível) — segue para o ecrã inicial normal
      }
    }

    /** Apaga o progresso guardado — chamado quando o exame termina
     *  (submissão ou desclassificação) ou quando o candidato sai. */
    async function clear() {
      if (!hasClaudeStorage) return;
      try {
        await window.storage.delete(KEY, false);
      } catch (err) {
        // nada a fazer: se a chave já não existe, o objectivo está cumprido
      }
    }

    return { save, load, clear };
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

    // Desde Agosto de 2026: a aprovação depende apenas da nota geral
    // ponderada — não existe mais um mínimo obrigatório por secção.
    const approved = weightedOverall >= CONFIG.APPROVAL_MIN_OVERALL_PERCENT;
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
      questionTimeLeftSeconds: CONFIG.QUESTION_DURATION_SECONDS, // cronómetro da questão actual (40s)
      questionDeadlineAt: null,  // timestamp (ms) em que o tempo desta questão termina — base para o cronómetro
      questionTimerIntervalId: null,
      examStartedAt: null,       // timestamp (ms) do início do exame — usado para calcular o tempo total usado
      tabSwitches: 0,
      disqualified: false,       // true quando ultrapassa o limite de mudanças de aba
      resumedSession: false,     // true quando este exame foi retomado após queda de rede/recarregamento
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
      dom('span', {}, [dom('b', {}, [`${CONFIG.QUESTION_DURATION_SECONDS}s`]), ' por questão']),
      dom('span', {}, [dom('b', {}, [String(CONFIG.QUESTIONS_PER_EXAM)]), ' questões']),
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
    const resumeBanner = state.resumedSession
      ? Banner('success', '✓ Sessão retomada — continuou exactamente na mesma questão e com o mesmo tempo restante de antes da interrupção.')
      : null;
    return dom('div', { class: 'exam-security' }, [
      resumeBanner,
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

  /** Recalcula os segundos restantes a partir do prazo absoluto
   *  (`questionDeadlineAt`) e devolve o valor, sem nunca ser negativo.
   *  Usar sempre este cálculo em vez de decrementar um contador — assim
   *  o tempo mostrado está sempre correcto, mesmo que o temporizador
   *  tenha estado parado (por exemplo, durante um recarregamento). */
  function computeRemainingQuestionSeconds() {
    if (!state.questionDeadlineAt) return CONFIG.QUESTION_DURATION_SECONDS;
    return Math.max(0, Math.round((state.questionDeadlineAt - Date.now()) / 1000));
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
   * Arranca (ou retoma) o cronómetro da questão actual, a partir do
   * prazo absoluto já definido em `state.questionDeadlineAt` (definido
   * em goToQuestionIndex ao mudar de questão, ou restaurado tal e qual
   * ao retomar uma sessão interrompida). Ao chegar a zero, a questão
   * fica automaticamente por responder (contada como errada na
   * correcção) e avança-se para a seguinte — ou submete-se o exame,
   * se for a última questão.
   */
  function startQuestionTimer() {
    stopQuestionTimer();
    state.questionTimeLeftSeconds = computeRemainingQuestionSeconds();
    updateTimerDisplayOnly(); // reflecte de imediato o tempo correcto — importante ao retomar uma sessão, para não mostrar por instantes o tempo cheio antes do primeiro tick
    if (state.questionTimeLeftSeconds <= 0) {
      actionAdvanceAfterTimeout();
      return;
    }
    state.questionTimerIntervalId = setInterval(() => {
      state.questionTimeLeftSeconds = computeRemainingQuestionSeconds();
      if (state.questionTimeLeftSeconds <= 0) {
        stopQuestionTimer();
        actionAdvanceAfterTimeout();
        return;
      }
      updateTimerDisplayOnly();
    }, 1000);
  }

  /**
   * Sinaliza que a página está a ser fechada ou recarregada (não uma
   * simples troca de aba). É definida ANTES de qualquer eventual
   * visibilitychange disparado pela mesma acção, para que esse evento
   * saiba distinguir "o candidato recarregou/fechou a página" (não
   * deve contar como mudança de aba suspeita — é exactamente o cenário
   * que a retoma de sessão existe para cobrir) de "o candidato saiu
   * para outra aba/app sem sair desta página" (isso sim conta).
   */
  let isNavigatingAway = false;
  window.addEventListener('pagehide', () => { isNavigatingAway = true; });
  window.addEventListener('beforeunload', () => { isNavigatingAway = true; });

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
    if (!document.hidden) {
      // A página voltou a ficar visível "normalmente" (sem ter sido destruída
      // por um recarregamento/fecho real) — repõe a flag, para que uma
      // eventual mudança de aba SEGUINTE volte a ser correctamente detectada.
      isNavigatingAway = false;
      return;
    }
    if (state.view !== 'exam') return;
    if (isNavigatingAway) return; // recarregamento/fecho de página — não é uma mudança de aba suspeita
    state.tabSwitches += 1;
    persistExamProgress();
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

  /**
   * Constrói um retrato ("snapshot") leve do exame em curso e grava-o
   * para retoma — chamado sempre que algo relevante muda (questão,
   * resposta, mudança de aba). É "fire-and-forget": não bloqueia a UI
   * nem impede o candidato de continuar caso a gravação falhe.
   */
  function persistExamProgress() {
    if (state.view !== 'exam' || !state.orderedQuestions.length) return;
    ExamProgress.save({
      candidate: state.candidate,
      orderedQuestionIds: state.orderedQuestions.map((q) => q.id),
      optionOrderByQuestion: state.optionOrderByQuestion,
      answers: state.answers,
      currentQuestionIndex: state.currentQuestionIndex,
      questionDeadlineAt: state.questionDeadlineAt,
      tabSwitches: state.tabSwitches,
      disqualified: state.disqualified,
      examStartedAt: state.examStartedAt,
      savedAt: Date.now(),
    });
  }

  /** Prepara a ordem (embaralhada, mas reprodutível) de perguntas e opções, e arranca no início. */
  function actionBeginExamSession() {
    // A semente inclui a hora exacta do pedido (Date.now()), não só o
    // nome/email — isto garante que o sorteio das 20 questões (entre
    // as 500 do banco) é realmente aleatório a cada tentativa, mesmo
    // que dois candidatos tenham nomes semelhantes ou o mesmo teste
    // seja repetido em ambiente de verificação/testes pela Comissão.
    const seed = seedFromText(state.candidate.name + state.candidate.email + String(Date.now()));
    state.orderedQuestions = selectExamQuestions(seed);
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
   * Muda para a questão indicada e reinicia o cronómetro (define um
   * novo prazo absoluto). É o único ponto que avança de questão —
   * usado tanto pelo clique em "Seguinte" como pelo avanço automático
   * ao esgotar o tempo. O progresso é gravado logo de seguida, para
   * que uma eventual queda de rede/recarregamento retome exactamente
   * a partir daqui.
   */
  function goToQuestionIndex(index) {
    state.currentQuestionIndex = index;
    state.questionDeadlineAt = Date.now() + CONFIG.QUESTION_DURATION_SECONDS * 1000;
    state.resumedSession = false; // o aviso de retoma só faz sentido na questão em que a sessão foi retomada
    render();
    startQuestionTimer();
    persistExamProgress();
  }

  function actionSelectAnswer(questionId, originalOptionIndex) {
    state.answers[questionId] = originalOptionIndex;
    render();
    persistExamProgress();
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
    ExamProgress.clear(); // o exame terminou — já não há nada para retomar

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
    ExamProgress.clear(); // o exame terminou — já não há nada para retomar

    state.saveStatus = await Storage.save(state.result);
    render();
  }

  /** Repõe a aplicação ao estado inicial (usado no botão "Sair" e após bloqueio de duplicado). */
  function actionExitToLanding() {
    stopQuestionTimer();
    ExamProgress.clear(); // saída deliberada — não faz sentido retomar depois
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
   * Antes de mostrar o ecrã inicial, tenta retomar uma sessão de exame
   * interrompida (queda de rede ou recarregamento da página). Se
   * encontrar uma sessão válida e ainda dentro do prazo de retoma
   * (CONFIG.RESUME_MAX_AGE_MS), reconstrói o estado exactamente onde
   * o candidato ficou — incluindo o tempo restante da questão actual,
   * recalculado a partir do prazo absoluto guardado. Caso contrário
   * (sem sessão, sessão corrompida, ou demasiado antiga), segue o
   * arranque normal a partir do ecrã inicial.
   * ===================================================================== */

  /**
   * Tenta retomar uma sessão de exame previamente guardada.
   * @returns {Promise<boolean>} true se retomou (já tratou de renderizar); false caso contrário.
   */
  async function tryResumeExam() {
    const saved = await ExamProgress.load();
    if (!saved || !Array.isArray(saved.orderedQuestionIds) || saved.orderedQuestionIds.length === 0) {
      return false;
    }

    const age = Date.now() - (saved.savedAt || 0);
    if (!saved.savedAt || age > CONFIG.RESUME_MAX_AGE_MS || age < 0) {
      ExamProgress.clear();
      return false;
    }

    const orderedQuestions = saved.orderedQuestionIds.map((id) => QUESTIONS_BY_ID.get(id)).filter(Boolean);
    if (orderedQuestions.length !== saved.orderedQuestionIds.length) {
      // o banco de questões mudou desde que esta sessão foi guardada (ex.: nova versão da plataforma) — não é seguro retomar
      ExamProgress.clear();
      return false;
    }

    state.candidate = saved.candidate || state.candidate;
    state.agreedToTerms = true;
    state.orderedQuestions = orderedQuestions;
    state.optionOrderByQuestion = saved.optionOrderByQuestion || {};
    state.answers = saved.answers || {};
    state.currentQuestionIndex = Math.min(saved.currentQuestionIndex || 0, orderedQuestions.length - 1);
    state.questionDeadlineAt = saved.questionDeadlineAt || (Date.now() + CONFIG.QUESTION_DURATION_SECONDS * 1000);
    state.tabSwitches = saved.tabSwitches || 0;
    state.disqualified = Boolean(saved.disqualified);
    state.examStartedAt = saved.examStartedAt || Date.now();
    state.resumedSession = true;

    if (state.disqualified) {
      // sessão já tinha terminado por desclassificação antes da interrupção
      actionSetView('disqualified');
      ExamProgress.clear();
      return true;
    }

    actionSetView('exam');
    startQuestionTimer(); // recalcula o tempo restante a partir do prazo absoluto guardado
    return true;
  }

  (async function init() {
    const resumed = await tryResumeExam();
    if (!resumed) render();
  })();

})();