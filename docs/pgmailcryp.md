# PgMailCryP : pilote de réception OpenPGP

Ce jalon ajoute une réception indépendante pour les boîtes personnelles ayant
publié une clé publique. Il **ne garantit pas le zero-access global de Doota**.
Aucun déploiement, DNS ou service externe n'est configuré par ce changement.

## Parcours disponible

1. Installer avec pnpm 11.29.0 (version dans `packageManager`). Le lockfile garde
   les versions Doota antérieures au premier commit PgMailCryP, avec OpenPGP.js
   6.3.3 et sa dépendance `eckey-utils` ajoutés. Les overrides et les autorisations de scripts `allowBuilds` sont dans
   `pnpm-workspace.yaml`, avec des valeurs booléennes valides. Le correctif
   pnpm 11 déjà publié sur GitHub est intégré ; `onlyBuiltDependencies` est
   remplacé par ces autorisations.
2. Appliquer localement les migrations avec `pnpm db:migrate:local`, dans un
   environnement Doota configuré. Les migrations 0058 (clé publique) et 0059
   (réception isolée) sont journalisées et ont leurs snapshots Drizzle.
3. Ouvrir `/pgmailcryp` dans une session autorisée. Générer ou importer une clé,
   exporter une sauvegarde de la clé privée chiffrée, choisir explicitement une
   boîte personnelle, puis activer la réception avec sa clé publique.
4. Après activation, une livraison Cloudflare Email Routing ou un POST du pont
   Stalwart vers cette boîte (y compris via ses alias) chiffre les octets MIME
   originaux avec la clé publique. Seuls le ciphertext R2 et sa référence D1 sont
   écrits. Cette réception n'utilise pas `MAIL_DEK` ni la file Doota.
5. Actualiser la réception dans l'atelier, déverrouiller la clé sur l'appareil,
   puis ouvrir le message. Le navigateur télécharge le ciphertext, le déchiffre,
   et parse le MIME avec postal-mime. Il affiche le texte, ou la source HTML
   échappée pour un message HTML seul. Il permet de télécharger les pièces
   jointes binaires et le MIME déchiffré. Aucun HTML de courriel n'est exécuté et
   aucune image distante n'est chargée par ce lecteur.

La clé privée protégée par phrase de passe reste dans le localStorage du
navigateur, sous la clé préexistante `pgmailcryp:encrypted-private-key`. La clé
ouverte est conservée en mémoire dans l'onglet. Verrouiller efface les références
au contenu déchiffré et à la clé ouverte, sans garantie d'effacement physique de
la mémoire JavaScript. Une seule paire locale est gérée par cet atelier ; le
stockage est lié au navigateur/origine, pas à un compte ni à une boîte.

La publication et la lecture vérifient directement dans D1 un droit non restreint
sur une boîte personnelle active et non service. Le cache d'autorisations n'est
pas utilisé. Une clé privée, plusieurs certificats, une clé expirée, révoquée ou
sans sous-clé de chiffrement utilisable sont refusés. Republier la même empreinte
est idempotent ; remplacer la clé est bloqué, même sous concurrence. La désactivation de ce mode
n’est pas encore proposée dans l’interface. Les
certificats existants ne sont pas actualisés par republication : rotation,
renouvellement et révocation nécessitent encore un parcours spécifique. Une clé
qui expire après activation provoque un échec de réception réessayable, jamais
un repli vers `MAIL_DEK`.

## Pourquoi un lecteur séparé

Le consumer historique charge le MIME chiffré avec `MAIL_DEK`, le déchiffre,
parse le MIME, extrait les pièces jointes vers R2, puis matérialise messages,
livraisons et fils. Il alimente aussi les règles, le spam, les invitations,
contacts, notifications et l'index FTS lisible. Les lecteurs Doota utilisent ces
lignes et ces objets dérivés. Remplacer leur MIME par un blob OpenPGP casserait
ce contrat et ne protégerait pas les copies dérivées déjà créées.

Le parcours pilote utilise donc `pgp_inbox_message` et `pgp/…` dans R2, avec un
contrat distinct de lecture MIME côté client. Il ne crée **aucune** ligne de
message, pièce jointe, fil, livraison, calendrier, contact, notification ou FTS.
Il n'offre pas encore fils, recherche, règles, antispam applicatif, notifications,
réponse, transfert ou analyse antivirus. La liste montre les 50 dernières
réceptions, sans pagination. Les messages et jobs déjà présents avant
l'activation restent dans le pipeline historique : aucune migration rétroactive
ni purge des anciennes données n'est réalisée.

## Données visibles et modèle de confiance

| Emplacement | Données visibles |
| --- | --- |
| SMTP, MTA/pont, ingress Worker | Enveloppe, en-têtes, sujet, corps, pièces jointes et résultats d'authentification ordinaires avant chiffrement ; journaux et spool du MTA selon sa configuration |
| D1 de ce pilote | Identifiant de boîte, SHA-256 du MIME, empreinte publique, chemin R2, heure de première persistance |
| R2 de ce pilote | MIME chiffré intégralement, clé d'objet incluant boîte/hash/empreinte, taille du ciphertext, dates d'écriture et identifiants OpenPGP publics du destinataire |
| D1 existant | Comptes, domaines, adresses, alias, droits d'accès et certificat public, indépendamment des messages |
| Navigateur | Clé privée protégée persistée ; clé ouverte, MIME, corps et pièces jointes déchiffrés en mémoire ; fichiers exportés explicitement |

Le hash permet de corréler des MIME identiques et de confirmer un MIME déjà connu.
La taille et le rythme des livraisons restent visibles. Les enveloppes et les
résultats d'authentification ne sont pas ajoutés en clair aux lignes du pilote ;
les en-têtes présents dans le MIME sont préservés à l'intérieur du ciphertext.
Les logs d'erreur Stalwart n'incluent ni corps, ni clé, ni token. Les logs MTA,
reverse-proxy et de plateforme ne sont pas contrôlés par ce code.

Le Worker chiffre, donc il voit le clair pendant l'ingress. Le serveur fournit
également le code JavaScript et le certificat destinataire : un serveur compromis
pourrait les remplacer. Ce jalon n'apporte ni vérification indépendante du code ou
des clés, ni garantie contre un serveur malveillant, ni signature de l'expéditeur.
Un destinataire non activé recevant la même copie peut conserver celle-ci dans
le stockage historique. Les envois, brouillons (dont les pièces jointes ouvertes),
notes, caches et index historiques restent soumis aux garanties Doota, où
`MAIL_DEK` est connu du serveur. Effacer le navigateur sans sauvegarde de la clé
privée peut rendre les messages du pilote définitivement illisibles.

## Contrat du pont Stalwart

`POST /ingress/stalwart` est un **contrat de pont à implémenter côté MTA**, pas
l'affirmation qu'un webhook natif Stalwart utilise déjà ce format. Rien n'est
branché à un MTA réel dans ce dépôt.

- HTTPS avec `Authorization: Bearer <STALWART_INGRESS_TOKEN>` ; le secret doit
  être fourni au Worker et au pont, jamais au navigateur. Absence de secret : 503.
- JSON : `rawBase64` (MIME original en base64 standard avec padding),
  `envelopeFrom` (chaîne vide autorisée pour les DSN), `envelopeTo` (une adresse).
  Champs facultatifs : `receivedAt` (nombre fini), `authenticationResults`
  (chaîne provenant du MTA de confiance), `messageId` (identifiant transport).
  Le Message-ID RFC utilisé par Doota est lu dans le MIME, pas dans `messageId`.
  Le timestamp fourni n'est pas utilisé pour ordonner la liste : l'heure de
  première persistance est retenue.
- Un appel par destinataire SMTP, y compris pour les BCC ; ne jamais reconstruire
  le MIME pour adapter les destinataires. Le pont doit réessayer les mêmes octets.
- Limite MIME de ce pont HTTP : 10 Mio. Corps JSON borné à 14 Mio pendant la lecture, même sans
  Content-Length. Les champs d'enveloppe et les métadonnées sont validés.

| Réponse | Obligation du pont/MTA |
| --- | --- |
| 202 | Livraison persistée dans R2 **et** D1 pour OpenPGP ; dans R2 **et** la file pour Doota. Le pont peut terminer la livraison. |
| 422 | Destinataire inconnu/inactif : échec permanent de destinataire (SMTP 550/DSN selon le stade). |
| 400, 413 | Format invalide ou trop gros : ne pas considérer livré ; rapport d'erreur/quarantaine explicite, et DSN si nécessaire. |
| 401, 405 | Défaut de configuration du pont : conserver la livraison et alerter l'opérateur. |
| 503, autre 5xx, timeout ou erreur réseau | Conserver le spool et réessayer avec backoff ; 503 indique Retry-After: 60 pour une panne de livraison. Expiration des retries gérée par le MTA, avec DSN. |

La persistance se fait R2 puis D1. Un échec D1 peut laisser un objet **chiffré**
orphelin ; la tentative suivante réutilise sa clé déterministe. Un timeout après
succès est sans perte : l'index unique `(mailbox_id, id)` évite les doublons.
La déduplication porte sur les octets exacts par boîte, pas sur Message-ID ; des
MIME modifiés entre tentatives peuvent produire deux entrées. Le chemin pilote
acquitte la persistance directement, sans consumer asynchrone. Les limites CPU et
mémoire du Worker pour le chiffrement avant acquittement (notamment avec les messages
Cloudflare, dont la limite reste celle du transport) doivent encore être
mesurées en environnement réel avant mise en production.

## Vérification locale sans service externe

`pnpm --filter doota exec vitest run src/test/pgp-ingress.test.ts` utilise les
vraies migrations SQLite en mémoire et OpenPGP.js, avec des doublures R2 et file.
Les tests couvrent publication/autorisations/révocation des droits, clés
invalides et remplacement, réception Stalwart et Cloudflare/alias, retransmission,
pannes de stockage, lecture protégée, restitution exacte du MIME et des octets
d'une pièce jointe binaire. Le chemin scellé est testé sans `MAIL_DEK`.

Générer les types locaux via `pnpm --filter doota gen` avant les contrôles web ;
`worker-configuration.d.ts` est généré et ignoré par Git. `pnpm test` exécute la
suite complète. Aucun test de ce jalon ne vérifie encore une vraie file Stalwart,
un échange SMTP réel, l'interface dans un navigateur authentifié ou la capacité
d'un Worker déployé.


## Résultats des contrôles de ce jalon

- Installation initiale pnpm 10.11.0 avec `--frozen-lockfile --ignore-scripts --offline` : réussie.
- Après intégration du correctif GitHub pnpm 11 : `pnpm install --frozen-lockfile`
  réussie avec pnpm 11.29.0, scripts de préparation exécutés ; les 622 tests et les
  contrôles TypeScript ciblés ont également été relancés avec cette version.
- `pnpm test` : 70 fichiers, 622 tests réussis, dont 13 tests PgMailCryP.
- TypeScript `@doota/db`, `@doota/mail-core`, `@doota/mail-in` : réussi.
- Génération Drizzle après 0059 : aucune différence de schéma restante.
- Build web : réussi avec `ORIGINS=http://localhost:5173` et un `SETUP_TOKEN`
  factice fourni uniquement à la commande ; aucune configuration externe créée.
- Contrôle web après génération des types : une erreur préexistante de types
  Vite 7/Vite 8 dans `apps/web/vite.config.ts`, et un avertissement Svelte
  préexistant dans `remote-content-card.svelte`. Même résultat reproduit sur une
  copie du commit antérieur à PgMailCryP utilisant les mêmes dépendances.
- `pnpm check` global reste arrêté par le type `@cloudflare/workers-types`
  absent de `packages/utils` ; échec également reproduit sur la copie antérieure.
  Aucun diagnostic introduit par PgMailCryP ne reste dans les contrôles ciblés.
