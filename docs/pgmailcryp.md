# PgMailCryP : parcours OpenPGP expérimental

La branche `codex/pgmailcryp-receive-pilot` contient le parcours expérimental de
composition, brouillons, envoi, réception et lecture. Ce n’est pas une release de
production ni une garantie zero-access globale. Chaque installation fournit son
propre domaine et le serveur de son choix.

## Installation locale groupée

L’[installateur local](../infra/local/README.md) construit l’application et démarre
ensemble Stalwart, le pont SMTP authentifié et le runtime Workers local. D1, R2,
KV et les files sont simulés localement par Wrangler ; aucun compte Cloudflare
n’est nécessaire pour cette installation isolée. Ce runtime de développement
n’est pas une distribution serveur de production.

L’installation ne crée aucun DNS et ne publie aucun port sur Internet. L’envoi
est limité au domaine configuré. Un accès par tunnel SSH à `localhost` permet de
vérifier le parcours sur une autre machine. Les images et pnpm sont verrouillés.
Les secrets sont propres à l’instance et conservés dans son répertoire privé.

## Utilisation avec deux comptes

1. Créer les comptes de test facultatifs Alice et Bob dans une instance vide,
   puis ouvrir leurs sessions dans deux profils de navigateur séparés.
2. Dans `/pgmailcryp`, choisir la boîte personnelle. Générer une clé avec une
   phrase de passe d’au moins 12 caractères, exporter sa sauvegarde chiffrée,
   puis publier sa clé publique. Faire cela pour les deux comptes.
3. Échanger les clés publiques et **comparer les empreintes complètes par un
   canal indépendant**. La recherche dans l’annuaire n’approuve jamais une clé.
4. Déverrouiller la clé, composer et joindre un petit fichier. Les brouillons
   sont chiffrés sur l’appareil avant IndexedDB ou transmission au serveur.
5. Envoyer. Le navigateur signe et chiffre le MIME protégé pour tous les
   destinataires et l’expéditeur. Le serveur reçoit uniquement ce ciphertext et
   l’enveloppe de routage. Les clés de contacts manquantes bloquent l’envoi.
6. Actualiser les envois. Dans l’installation groupée, le chemin passe par le
   pont HTTP, la soumission SMTP à Stalwart, sa file durable, le pont SMTP
   authentifié et `/ingress/stalwart` avant stockage.
7. Dans le profil de Bob, actualiser la réception et lire sur l’appareil. Vérifier
   la signature, l’objet, le texte et les octets de la pièce jointe. Répondre ou
   transférer utilise le même compositeur chiffré. Alice peut lire sa copie envoyée.

Le lecteur traite plusieurs couches PGP/MIME, des parties binaires/base64 et les
signatures détachées. Une signature n’est attribuée à une identité que si elle
correspond à la clé épinglée pour l’adresse de l’expéditeur. Il distingue
`verified`, `invalid`, `unverified` et `unsigned`. L’enveloppe de chiffrement au
stockage d’un courriel ordinaire ne devient pas une signature de l’expéditeur.
Le HTML est affiché comme texte ; aucune image distante n’est chargée.

## Clés et autorisations

La clé privée protégée est dans le localStorage **par utilisateur et boîte**. La
clé ouverte et les données déchiffrées restent en mémoire dans l’onglet. Le
bouton de verrouillage retire ces références de l’écran, sans garantie
d’effacement physique de la mémoire JavaScript. L’ancienne clé de l’atelier peut
être récupérée explicitement ; elle n’est pas supprimée automatiquement.

Les accès aux clés, listes et objets vérifient directement D1 : boîte personnelle
active, non service, droit non restreint. Écrire/publier/envoyer exige `canSend` et
un domaine actif. Le consumer recontrôle les droits avant la livraison. Les
boîtes partagées sont exclues. Remplacer une empreinte déjà publiée est bloqué,
y compris sous concurrence ; rotation et récupération restent à concevoir.
Les certificats privés, multiples, expirés, révoqués ou inutilisables sont refusés
à la publication. Un certificat expirant après activation provoque un échec
réessayable, sans repli en clair.

## Stockage et métadonnées

| Emplacement | Données visibles |
| --- | --- |
| D1, annuaire | Comptes, domaines, adresses, alias, droits, clés publiques et empreintes |
| D1, réception | Boîte, hash du MIME reçu, empreinte, chemin R2, date |
| D1, brouillons | Propriétaire, boîte, identifiant, révision, chemin R2, date |
| D1, envois | Expéditeur, destinataires SMTP dont Cci, identifiants, hash, chemin R2, dates, états et tentatives par destinataire |
| R2, brouillons | JSON chiffré contenant objet, corps, destinataires et pièces jointes |
| R2, envois | MIME PGP chiffré avec objet externe fixe « Message OpenPGP » ; From/To/Cc externes, aucun en-tête Bcc |
| R2, réception | Octets MIME originaux intégralement chiffrés avec la clé publique de la boîte |
| Navigateur | Clé privée protégée, contacts publics épinglés, brouillons et envois en attente chiffrés ; données ouvertes en mémoire |
| SMTP / MTA / pont | Enveloppe, From/To/Cc externes, taille, horaires ; contenu lisible si le correspondant n’a pas chiffré avant SMTP |

Les identifiants des clés destinataires dans les nouveaux messages émis sont
masqués (wildcard OpenPGP). Le serveur connaît néanmoins les destinataires SMTP,
y compris les Cci. Les parties protégées contiennent l’objet réel, le texte et
les pièces jointes. Les clients externes peuvent laisser leur objet en clair.
Un hash permet de corréler des messages identiques ou de confirmer un MIME connu.
Les copies en attente dans IndexedDB gardent aussi le routage de l’envoi décidé,
jamais le corps ou les noms de pièces jointes en clair.

Aucun message, pièce jointe extraite, fil, contact, notification, calendrier ou
index FTS historique n’est créé par la réception PgMailCryP. Le consumer Doota
continue à parser/materialiser les messages des boîtes non activées. Les chemins
historiques d’envoi/brouillon/pièce jointe refusent les écritures pour une boîte
activée : ils ne constituent pas un repli silencieux. Les anciens contenus et
jobs ne sont pas migrés rétroactivement.

## Fiabilité et contrat SMTP

`POST /ingress/stalwart` attend HTTPS et un bearer `STALWART_INGRESS_TOKEN` partagé
avec le pont. L’exception HTTP est réservée au loopback du test isolé. Sans secret
configuré : 503 ; mauvaise authentification : 401. JSON : `rawBase64` (base64
standard), `envelopeFrom` (vide autorisé pour les DSN), `envelopeTo` unique.
Les champs optionnels sont `receivedAt`, `authenticationResults`, `messageId`.
L’heure du serveur ordonne les réceptions et le Message-ID RFC vient du MIME.

Le pont attend une persistance 202 avant de répondre SMTP 250. Les échecs réseau
et temporaires deviennent 451 pour que Stalwart garde et réessaie sa livraison ;
un destinataire indisponible devient 550. Un RCPT par transaction évite un
acquittement partiel ambigu. Les doublons de MIME sont dédupliqués par boîte.
Le spool Stalwart est durable dans un volume ; les journaux MTA et plateforme
restent à contrôler selon l’environnement de production.

L’envoi conserve l’intention et l’enveloppe en D1 avant de soumettre à la file.
Une reprise répare les destinataires manquants. Chaque destinataire a un verrou
CAS, un bail de 10 minutes et jusqu’à 8 tentatives avec délai. Le pont conserve
ses reçus SMTP dans SQLite/WAL. Une répétition avec le même identifiant et même
contenu retrouve son résultat ; un contenu différent est refusé. Une acceptation
SMTP indéterminée requiert un consentement explicite avant nouvelle tentative
potentiellement dupliquée. `sent` signifie accepté par le transport, pas lu ni
nécessairement livré définitivement : les DSN de Stalwart ne sont pas encore
réconciliés dans ces états.

## Vérifications

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
node --test infra/local/*.test.mjs
```

Les migrations 0058 (clé), 0059 (réception) et 0060 (brouillons/envois) ont leur
snapshot et leur entrée dans le journal Drizzle. Les tests appliquent les vraies
migrations SQLite. Ils vérifient les autorisations, les révisions de brouillon,
la confidentialité des objets, le MIME/signatures/pièces jointes, la reprise de
file et un transfert SMTP loopback réel. Les doublures R2 et D1 de cette suite ne
remplacent pas le test d’installation et de navigateur documenté séparément.

## Limites de sécurité et fonctionnelles

Un courriel ordinaire reste lisible au premier serveur SMTP et à l’ingress avant
chiffrement. Déplacer ce chiffrement dans Stalwart protégerait les Workers du
clair, mais Stalwart le verrait encore. Seul un chiffrement avant l’arrivée sur
le premier serveur SMTP évite cet accès au contenu. TLS seul ne le fait pas.
Le serveur distribue aussi le JavaScript : un serveur compromis peut tenter de
le remplacer. Les empreintes indépendantes réduisent le risque de substitution
de clé, sans rendre le code navigateur indépendant du serveur.

Restent notamment : audit, récupération/rotation/révocation des clés, boîtes
partagées, pagination (50 derniers reçus/envois), recherche et fils locaux,
notifications confidentielles, rapprochement des retours SMTP, installation de
production avec TLS, sauvegardes/restauration, DKIM/SPF/DMARC et relais externe.
Les notes, caches et données historiques Doota ne sont pas convertis. Les exports
volontaires sont lisibles sur l’appareil. Perdre la clé privée et sa phrase de
passe peut rendre les messages définitivement illisibles.

## Jalon vérifié le 26 novembre 2026

- `pnpm check` : aucune erreur ; un avertissement Svelte préexistant dans le
  composant d’administration `remote-content-card.svelte`, non modifié.
- `pnpm test` : 653 tests, 74 fichiers, tous réussis.
- Tests de configuration locale : 2 tests réussis, dont réapplication des
  identités Stalwart sans modification de champs immuables.
- Construction Linux/Docker et migrations locales réussies ; secrets, comptes
  et volumes conservés lors d’une réinstallation.
- Firefox réel, deux sessions : clés sur l’appareil, publication et contacts
  épinglés, brouillon chiffré, envoi via Stalwart, lecture, signature vérifiée,
  pièce jointe binaire exacte, copie envoyée, réponse et transfert livrés.
  Aucun marqueur de contenu ou phrase de passe du test dans les corps des appels
  `fetch` surveillés.

Ces résultats concernent l’environnement isolé décrit ici. Ils ne constituent
pas un audit, une validation SMTP Internet ou une certification zero-access.


## Premier démarrage de l’installation groupée

L’installateur configure le transport avec le domaine fourni et écrit un lien
privé `setup-url.txt`. Les Workers reçoivent explicitement
`PGMAILCRYP_INSTALL_MODE=isolated-local-test` et `PGMAILCRYP_DOMAIN`. Hors de ce
mode, le parcours Doota existant conserve son comportement.

Sur une base vide, `/setup` valide le jeton et crée le premier administrateur,
son organisation, son appartenance comme propriétaire, sa boîte personnelle et
son droit d’envoi. La première organisation réserve le démarrage pour empêcher
deux créations concurrentes. Les écritures de compte restent dans la frontière
d’authentification ; un échec ordinaire nettoie les données créées et permet une
nouvelle tentative. Une réservation laissée par une interruption brutale arrête
la reprise automatique et exige une récupération opérateur.

Le domaine est routable **localement** : l’état `active` ne signifie pas que son
DNS public est vérifié. Le nom de domaine n’est pas fourni par le formulaire,
qui ne peut donc pas modifier le transport préconfiguré. L’adresse de connexion
administrateur doit être extérieure au domaine installé et à ses sous-domaines.
Le parcours impose ensuite TOTP et une passkey, sans contourner les contrôles
existants. L’import historique en clair n’est pas proposé pendant ce démarrage.

Après cette protection, `/admin/installation` affiche le routage local, l’état du
pont et de l’authentification SMTP Stalwart, puis les boîtes personnelles
explicitement autorisées. Les droits et facteurs sont relus dans D1. La sonde
`GET /health` du pont exige son bearer serveur et vérifie SMTP sans envoyer de
message. Ses réponses sont des codes fixes, sans détail SMTP ni secret. La page
ne reçoit ni les identifiants Stalwart, ni le token du pont, ni `MAIL_DEK`.
Les réponses de configuration sont `no-store`, le premier démarrage applique
`Referrer-Policy: no-referrer`, et l’écran ne demande aucune clé privée OpenPGP.

Les comptes de démonstration existants sont conservés et ne sont pas élevés en
administrateurs. Le premier démarrage reste verrouillé dès qu’un compte existe.
Ce jalon simplifie l’installation de test ; le runtime Wrangler local, la
restauration, les mises à jour de production et la reprise automatique d’un
bootstrap interrompu restent des travaux distincts.

Validation du premier démarrage : formulaire réel Firefox sur une instance vide,
authentification SMTP Stalwart réussie, création du compte et de sa boîte,
connexion par mot de passe, accès administrateur bloqué jusqu’aux facteurs
requis, premier démarrage verrouillé après création et aucune page de setup ni
jeton dans CacheStorage. L’enrôlement matériel de passkey n’est pas automatisé
par ce test. Une erreur de chargement du favicon via le service worker existant
a été observée lors du premier essai ; le test distingue précisément cette
erreur de ressource des erreurs de l’application. Le second essai a réussi.
Après mise à jour de l’instance de test déjà peuplée, le parcours Firefox complet
(envoi, réception Stalwart, signatures, octets de pièce jointe, réponse et
transfert) a également réussi avec les clés déjà publiées et les comptes
conservés.
