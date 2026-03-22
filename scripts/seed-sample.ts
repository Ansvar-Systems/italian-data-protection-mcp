/**
 * Seed the Garante database with sample decisions and guidelines for testing.
 *
 * Includes real Garante decisions (Clearview AI, Foodinho/Glovo, ENI Gas e Luce)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["GARANTE_DB_PATH"] ?? "data/garante.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_it: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "cookie",
    name_it: "Cookie e tracciamento",
    name_en: "Cookies and tracking",
    description: "Utilizzo di cookie e tecnologie di tracciamento — consenso e obblighi informativi (art. 7 GDPR, provvedimento Garante 10 giugno 2021).",
  },
  {
    id: "videosorveglianza",
    name_it: "Videosorveglianza",
    name_en: "Video surveillance",
    description: "Sistemi di videosorveglianza in luoghi pubblici e privati — proporzionalità e informativa (art. 5-6 GDPR, provvedimento generale Garante).",
  },
  {
    id: "profilazione",
    name_it: "Profilazione",
    name_en: "Profiling",
    description: "Profilazione degli utenti e decisioni automatizzate con effetti significativi (art. 22 GDPR).",
  },
  {
    id: "telemarketing",
    name_it: "Telemarketing",
    name_en: "Telemarketing",
    description: "Contatto a fini commerciali tramite telefono, email e altri canali — consenso e registro delle opposizioni (RPO).",
  },
  {
    id: "dati_sanitari",
    name_it: "Dati sanitari",
    name_en: "Health data",
    description: "Trattamento di dati relativi alla salute — categorie particolari soggette a garanzie rafforzate (art. 9 GDPR).",
  },
  {
    id: "diritto_oblio",
    name_it: "Diritto all'oblio",
    name_en: "Right to be forgotten",
    description: "Diritto alla cancellazione (diritto all'oblio) dei dati personali online (art. 17 GDPR).",
  },
  {
    id: "trasferimento_dati",
    name_it: "Trasferimento internazionale di dati",
    name_en: "International data transfers",
    description: "Trasferimento di dati personali verso paesi terzi — clausole standard e garanzie adeguate (artt. 44-49 GDPR).",
  },
  {
    id: "valutazione_impatto",
    name_it: "Valutazione d'impatto sulla protezione dei dati",
    name_en: "Data Protection Impact Assessment",
    description: "Valutazione d'impatto (DPIA/VIPD) per trattamenti ad alto rischio (art. 35 GDPR).",
  },
  {
    id: "trattamento_automatizzato",
    name_it: "Trattamento automatizzato e decisioni algoritmiche",
    name_en: "Automated processing and algorithmic decisions",
    description: "Trattamento automatizzato e decisioni basate su algoritmi con effetti significativi sulle persone (art. 22 GDPR).",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_it, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_it, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // Clearview AI
  {
    reference: "GPDP-2022-001",
    title: "Ordinanza-ingiunzione — Clearview AI Inc. (dati biometrici, trattamento illecito)",
    date: "2022-03-10",
    type: "ordinanza",
    entity_name: "Clearview AI Inc.",
    fine_amount: 20_000_000,
    summary:
      "Il Garante ha sanzionato Clearview AI con una multa di 20 milioni di euro per raccolta illecita di dati biometrici di cittadini italiani senza base giuridica, mancato rispetto dei diritti degli interessati e assenza di un rappresentante nell'UE.",
    full_text:
      "Il Garante per la protezione dei dati personali ha adottato un'ordinanza-ingiunzione nei confronti di Clearview AI Inc., irrogando una sanzione amministrativa di 20.000.000 di euro. Clearview AI raccoglie automaticamente miliardi di fotografie di persone da fonti pubblicamente accessibili su internet per costruire un database di riconoscimento facciale. Tale servizio è stato utilizzato principalmente da forze dell'ordine. Il Garante ha accertato le seguenti violazioni: (1) Assenza di base giuridica — il trattamento di dati biometrici di cittadini italiani è avvenuto in assenza di una delle condizioni previste dall'art. 9 del GDPR; il consenso degli interessati non era stato ottenuto né erano presenti altre basi giuridiche applicabili; (2) Violazione dei principi di trasparenza e correttezza — gli interessati non erano stati informati del trattamento dei loro dati; (3) Mancato riscontro alle richieste degli interessati — le richieste di accesso, cancellazione e opposizione non erano state evase o lo erano state in maniera insufficiente; (4) Assenza di un rappresentante nell'UE ai sensi dell'art. 27 del GDPR. Il Garante ha ordinato a Clearview AI di cancellare tutti i dati relativi a cittadini italiani.",
    topics: JSON.stringify(["trasferimento_dati", "valutazione_impatto"]),
    gdpr_articles: JSON.stringify(["5", "6", "9", "12", "15", "17", "21", "27"]),
    status: "final",
  },
  // Foodinho / Glovo — algoritmo
  {
    reference: "GPDP-2021-FG",
    title: "Provvedimento — Foodinho S.r.l. (Glovo) — decisioni algoritmiche sui rider",
    date: "2021-07-22",
    type: "provvedimento",
    entity_name: "Foodinho S.r.l. (Glovo)",
    fine_amount: 2_600_000,
    summary:
      "Il Garante ha sanzionato Foodinho (Glovo) con 2,6 milioni di euro per uso illecito di algoritmi per la gestione dei rider — assenza di trasparenza sul funzionamento dell'algoritmo, raccolta eccessiva di dati di geolocalizzazione e mancata valutazione d'impatto.",
    full_text:
      "Il Garante per la protezione dei dati personali ha adottato un provvedimento nei confronti di Foodinho S.r.l. (che opera con il marchio Glovo in Italia), irrogando una sanzione complessiva di 2.600.000 euro. Le violazioni accertate riguardano il trattamento dei dati dei rider mediante sistemi algoritmici: (1) Mancanza di trasparenza sull'algoritmo — i rider non erano informati in modo chiaro e comprensibile del funzionamento del sistema algoritmico che determinava l'assegnazione degli ordini, il calcolo del punteggio di reputazione (excellency score) e le eventuali esclusioni dalla piattaforma; (2) Raccolta eccessiva di dati di geolocalizzazione — i dati di posizione dei rider venivano raccolti anche nelle fasi in cui non erano attivi per una consegna, senza giustificazione; (3) Decisioni automatizzate senza adeguate garanzie — l'esclusione dei rider dalla piattaforma avveniva attraverso decisioni automatizzate senza un'adeguata revisione umana; (4) Mancanza di valutazione d'impatto — non era stata effettuata una VIPD (valutazione d'impatto sulla protezione dei dati) nonostante il trattamento presentasse rischi elevati per i diritti dei rider. Il Garante ha ordinato a Foodinho di adottare specifiche misure correttive entro 180 giorni.",
    topics: JSON.stringify(["trattamento_automatizzato", "profilazione", "valutazione_impatto"]),
    gdpr_articles: JSON.stringify(["5", "13", "22", "35"]),
    status: "final",
  },
  // ENI Gas e Luce — telemarketing
  {
    reference: "GPDP-2020-ENI",
    title: "Ordinanza-ingiunzione — ENI Gas e Luce S.p.A. (telemarketing illecito)",
    date: "2020-11-12",
    type: "ordinanza",
    entity_name: "ENI Gas e Luce S.p.A.",
    fine_amount: 11_500_000,
    summary:
      "Il Garante ha sanzionato ENI Gas e Luce con 11,5 milioni di euro per una vasta campagna di telemarketing illecito realizzata tramite call center terzi, senza consenso degli utenti e in violazione del Registro delle opposizioni (RPO).",
    full_text:
      "Il Garante per la protezione dei dati personali ha adottato un'ordinanza-ingiunzione nei confronti di ENI Gas e Luce S.p.A., irrogando una sanzione di 11.500.000 euro per gravi e reiterate violazioni in materia di telemarketing. Le violazioni accertate: (1) Contatti telefonici senza consenso — ENI Gas e Luce effettuava chiamate commerciali a utenti che non avevano prestato il consenso al trattamento per finalità di marketing, affidandosi a reti di call center terzi che operavano sulla base di liste di contatti non conformi; (2) Violazione del Registro delle Opposizioni — venivano contattate persone iscritte al Registro delle Opposizioni (ex RPO), nonostante il divieto esplicito di effettuare chiamate commerciali a tali utenti; (3) Utilizzo di dati raccolti illecitamente da terzi — i call center utilizzavano liste di contatti acquisite da terze parti senza adeguata verifica della liceità delle operazioni di raccolta del consenso; (4) Mancanza di adeguate misure di controllo — ENI Gas e Luce non aveva implementato misure di controllo adeguate sui fornitori di servizi di telemarketing, in violazione delle prescrizioni sulle responsabilità del titolare del trattamento. Il Garante ha ordinato all'azienda di adottare un piano di conformità dettagliato.",
    topics: JSON.stringify(["telemarketing"]),
    gdpr_articles: JSON.stringify(["5", "6", "7", "28"]),
    status: "final",
  },
  // TikTok — minori
  {
    reference: "GPDP-2021-TT",
    title: "Provvedimento — TikTok Technology Limited (dati di minori)",
    date: "2021-07-22",
    type: "provvedimento",
    entity_name: "TikTok Technology Limited",
    fine_amount: null,
    summary:
      "Il Garante ha ordinato a TikTok di bloccare immediatamente il trattamento dei dati degli utenti italiani di cui non era possibile accertare l'età, dopo il decesso di una bambina di 10 anni che partecipava a una sfida pericolosa diffusa sulla piattaforma.",
    full_text:
      "Il Garante per la protezione dei dati personali ha adottato un provvedimento urgente nei confronti di TikTok Technology Limited, ordinando il blocco immediato del trattamento dei dati degli utenti italiani di cui non fosse possibile accertare con certezza l'età. Il provvedimento è stato adottato a seguito del decesso di una bambina di 10 anni a Palermo che aveva partecipato alla Blackout Challenge — una sfida virale che incoraggiava a tenersi la gola stretta fino allo svenimento. Il Garante ha accertato che TikTok: (1) Non adottava misure adeguate per verificare l'età degli utenti — la piattaforma permetteva l'iscrizione e il caricamento di contenuti anche a minori di 13 anni (soglia minima prevista dai propri termini di servizio) senza un'adeguata verifica dell'età; (2) Non garantiva la sicurezza dei minori online — contenuti potenzialmente pericolosi erano accessibili anche ai minori iscritti; (3) Non rispettava il divieto di trattare i dati dei minori di 13 anni senza il consenso dei genitori. In seguito a questo provvedimento, TikTok ha adottato misure per rafforzare i controlli sull'età in Italia e ha rimosso circa 600.000 profili di utenti italiani di cui non era possibile verificare l'età.",
    topics: JSON.stringify(["profilazione"]),
    gdpr_articles: JSON.stringify(["5", "6", "8", "25"]),
    status: "final",
  },
  // Wind Tre — telemarketing
  {
    reference: "GPDP-2020-WT",
    title: "Ordinanza-ingiunzione — Wind Tre S.p.A. (telemarketing, consensi non validi)",
    date: "2020-06-18",
    type: "ordinanza",
    entity_name: "Wind Tre S.p.A.",
    fine_amount: 16_700_000,
    summary:
      "Il Garante ha sanzionato Wind Tre con 16,7 milioni di euro per una sistematica attività di telemarketing realizzata tramite consensi non validamente acquisiti e per il mancato rispetto del diritto di opposizione degli utenti.",
    full_text:
      "Il Garante per la protezione dei dati personali ha adottato un'ordinanza-ingiunzione nei confronti di Wind Tre S.p.A., irrogando una sanzione di 16.700.000 euro — una delle più elevate in Europa in materia di telemarketing. Le violazioni accertate: (1) Consensi non validi per il telemarketing — i consensi raccolti attraverso concorsi, app, form online e portali di terzi non rispettavano i requisiti del GDPR: non erano specifici, liberi e inequivocabili; spesso erano stati ottenuti come condizione per partecipare a concorsi o accedere a servizi; (2) Mancato rispetto del diritto di opposizione — le richieste degli utenti di non essere più contattati a fini commerciali non venivano trasmesse tempestivamente ai call center, che continuavano a effettuare chiamate; (3) Utilizzo di liste di dubbia provenienza — Wind Tre si avvaleva di liste di contatti acquisite da terzi senza effettuare adeguati controlli sulla liceità della raccolta dei consensi originali; (4) Mancanza di procedure di controllo adeguate sui call center — non erano previste procedure efficaci per garantire che i call center rispettassero la normativa sulla protezione dei dati.",
    topics: JSON.stringify(["telemarketing"]),
    gdpr_articles: JSON.stringify(["5", "6", "7", "21"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "GPDP-LG-COOKIE-2021",
    title: "Linee guida cookie e altri strumenti di tracciamento — 10 giugno 2021",
    date: "2021-06-10",
    type: "linee_guida",
    summary:
      "Le linee guida del Garante su cookie e altri strumenti di tracciamento aggiornano e sostituiscono il provvedimento del 2014. Definiscono le condizioni per un valido consenso, le categorie di cookie soggetti a consenso, i requisiti dei banner e le modalità di gestione delle preferenze.",
    full_text:
      "Il Garante ha adottato le nuove linee guida in materia di cookie e altri strumenti di tracciamento, tenendo conto dell'evoluzione tecnologica e del quadro normativo del GDPR. Consenso per i cookie: Il consenso è richiesto per tutti i cookie e strumenti di tracciamento che non siano strettamente necessari alla fornitura del servizio. Il consenso deve essere: libero — non condizionato all'accesso al sito (il cookie wall è vietato, salvo casi eccezionali); specifico — per ciascuna finalità del trattamento; informato — l'utente deve comprendere a cosa sta acconsentendo; inequivocabile — richiede un'azione positiva dell'utente. Cookie tecnici esenti da consenso: I cookie strettamente necessari al funzionamento del sito (cookie di sessione, cookie di autenticazione, cookie relativi al carrello della spesa) sono esenti dall'obbligo di consenso. Requisiti del banner: (1) Il banner deve consentire di rifiutare i cookie con la stessa facilità con cui è possibile accettarli — deve essere presente un tasto \"Rifiuta\" o equivalente sullo stesso livello del tasto \"Accetta\"; (2) Il banner non deve prevedere \"dark pattern\" che inducano l'utente ad acconsentire; (3) La scelta deve poter essere modificata in qualsiasi momento. Durata del consenso: Il consenso ha una durata massima di 6 mesi dopo la prima visita, trascorsi i quali va rinnovato. Prova del consenso: Il titolare deve essere in grado di dimostrare che l'utente ha prestato un consenso valido.",
    topics: JSON.stringify(["cookie"]),
    language: "it",
  },
  {
    reference: "GPDP-VS-2010",
    title: "Provvedimento generale — Videosorveglianza (8 aprile 2010)",
    date: "2010-04-08",
    type: "provvedimento_generale",
    summary:
      "Il provvedimento generale del Garante sulla videosorveglianza stabilisce le condizioni di liceità per l'installazione e l'uso di impianti di videosorveglianza nei luoghi pubblici, aperti al pubblico e privati. Definisce obblighi informativi, tempi di conservazione e misure di sicurezza.",
    full_text:
      "Il Garante ha adottato un provvedimento generale in materia di videosorveglianza che fissa le regole applicabili a tutti i soggetti pubblici e privati che installano e gestiscono impianti di videosorveglianza. Principio di proporzionalità: I sistemi di videosorveglianza devono essere proporzionati alle finalità perseguite. Non è ammessa la sorveglianza generalizzata di spazi pubblici che non presentino particolari esigenze di sicurezza. Informativa agli interessati: Chiunque transiti in un'area videosorvegliata deve essere informato mediante appositi cartelli visibili prima dell'ingresso nell'area, recanti il simbolo di una telecamera e le informazioni essenziali sul trattamento. Tempi di conservazione: Le immagini non possono essere conservate per più di 24-48 ore, salvo esigenze specifiche documentate. Per soggetti pubblici le immagini possono essere conservate fino a 7 giorni; per indagini giudiziarie possono essere conservate fino alla definizione del procedimento. Sorveglianza dei lavoratori: La videosorveglianza dei lavoratori sui luoghi di lavoro richiede accordo con le rappresentanze sindacali o autorizzazione dell'Ispettorato del lavoro. Non è ammessa la sorveglianza continua dei lavoratori nei luoghi di pausa. Misure di sicurezza: Le immagini devono essere protette da accessi non autorizzati mediante misure tecniche adeguate.",
    topics: JSON.stringify(["videosorveglianza"]),
    language: "it",
  },
  {
    reference: "GPDP-LG-PROFILING-2019",
    title: "Linee guida sulla profilazione online e i sistemi di raccomandazione",
    date: "2019-02-07",
    type: "linee_guida",
    summary:
      "Le linee guida del Garante sulla profilazione online spiegano le condizioni per il trattamento lecito dei dati a fini di profilazione, i diritti degli interessati riguardo alle decisioni automatizzate e i requisiti di trasparenza algoritmica.",
    full_text:
      "La profilazione è definita dal GDPR come qualsiasi forma di trattamento automatizzato di dati personali consistente nell'utilizzo di tali dati per valutare determinati aspetti personali relativi a una persona fisica. Le linee guida del Garante chiariscono: Basi giuridiche per la profilazione: La profilazione richiede una base giuridica valida. Il consenso deve essere specifico per la finalità di profilazione e non può essere bundled con altri servizi. Il legittimo interesse può essere invocato solo se non prevale sugli interessi e i diritti fondamentali degli interessati — tenendo conto dell'impatto sulla sfera privata. Decisioni automatizzate con effetti significativi: L'art. 22 del GDPR richiede che le decisioni basate unicamente su trattamento automatizzato che producano effetti significativi siano sottoposte a garanzie specifiche: diritto dell'interessato a ottenere l'intervento umano; diritto di esprimere la propria opinione; diritto di contestare la decisione. Esempi: scoring creditizio, profilazione nelle assunzioni, sistemi di raccomandazione che determinano l'accesso a opportunità. Trasparenza algoritmica: Il titolare deve fornire informazioni significative sulla logica, il significato e le conseguenze previste del processo automatizzato. Non è necessario divulgare algoritmi proprietari, ma occorre spiegare i criteri fondamentali utilizzati. Valutazione d'impatto: Per la profilazione sistematica e su larga scala è obbligatoria la VIPD.",
    topics: JSON.stringify(["profilazione", "trattamento_automatizzato", "valutazione_impatto"]),
    language: "it",
  },
  {
    reference: "GPDP-VIPD-2017",
    title: "Linee guida — Valutazione d'impatto sulla protezione dei dati (VIPD/DPIA)",
    date: "2017-10-04",
    type: "linee_guida",
    summary:
      "Le linee guida del Garante recepiscono e integrano le linee guida del Gruppo di lavoro Articolo 29 sulla valutazione d'impatto sulla protezione dei dati (DPIA/VIPD) prevista dall'art. 35 del GDPR.",
    full_text:
      "La valutazione d'impatto sulla protezione dei dati (VIPD, o DPIA in inglese) è uno strumento fondamentale per garantire la conformità al GDPR per i trattamenti che presentano un rischio elevato per i diritti e le libertà delle persone. Quando è obbligatoria la VIPD? La VIPD è obbligatoria quando il trattamento: (1) Utilizza in modo sistematico dati personali per valutare aspetti personali, in particolare attraverso la profilazione; (2) Tratta su larga scala categorie particolari di dati (dati sanitari, biometrici, genetici, etc.) o dati relativi a condanne penali; (3) Monitora sistematicamente aree accessibili al pubblico su larga scala. Il Garante ha pubblicato un elenco delle tipologie di trattamenti per i quali è obbligatoria la VIPD. Contenuto della VIPD: La valutazione deve includere: una descrizione sistematica dei trattamenti e delle finalità; una valutazione della necessità e proporzionalità dei trattamenti; una valutazione dei rischi per i diritti e le libertà degli interessati; le misure previste per affrontare i rischi. Consultazione preventiva: Se la VIPD indica che il trattamento presenterebbe ancora un rischio elevato nonostante le misure adottate, il titolare deve consultare preventivamente il Garante prima di procedere. Il Garante risponde entro 8 settimane, prorogabili di altre 6 settimane.",
    topics: JSON.stringify(["valutazione_impatto"]),
    language: "it",
  },
  {
    reference: "GPDP-DATI-SANITARI-2016",
    title: "Autorizzazione generale — Trattamento dei dati personali in ambito sanitario",
    date: "2016-12-15",
    type: "provvedimento_generale",
    summary:
      "Il provvedimento del Garante sul trattamento dei dati sanitari stabilisce le condizioni per il lecito trattamento dei dati relativi alla salute da parte di professionisti sanitari, strutture sanitarie, ricercatori e datori di lavoro.",
    full_text:
      "I dati relativi alla salute sono una categoria particolare di dati personali ai sensi dell'art. 9 del GDPR e richiedono garanzie rafforzate. Il Garante ha definito le condizioni per il loro trattamento lecito: Trattamento da parte di professionisti sanitari: Il trattamento dei dati sanitari da parte di medici, ospedali e strutture sanitarie è lecito se necessario per finalità di medicina preventiva, diagnosi, assistenza o terapia sanitaria o sociale, o per la gestione dei sistemi e servizi sanitari (art. 9, par. 2, lett. h, GDPR). I pazienti devono essere adeguatamente informati e i dati devono essere trattati sotto la responsabilità di un professionista soggetto al segreto professionale. Ricerca scientifica in ambito sanitario: Il trattamento a fini di ricerca è lecito se sussistono opportune garanzie: pseudonimizzazione o anonimizzazione dei dati; accesso limitato ai ricercatori che ne hanno bisogno; VIPD obbligatoria; informativa adeguata. Trattamento da parte del datore di lavoro: Il datore di lavoro può accedere ai dati sanitari del dipendente solo nelle ipotesi tassativamente previste dalla legge — ad esempio per valutare l'idoneità alla mansione da parte del medico competente. È vietato al datore di lavoro acquisire direttamente certificati medici che indichino la diagnosi. Cartella clinica elettronica e Fascicolo sanitario elettronico (FSE): Devono essere previste misure di sicurezza adeguate, incluso il controllo degli accessi basato sul ruolo.",
    topics: JSON.stringify(["dati_sanitari", "valutazione_impatto"]),
    language: "it",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
