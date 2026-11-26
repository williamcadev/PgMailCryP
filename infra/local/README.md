# Installation locale de test PgMailCryP + Stalwart

Ce regroupement expérimental utilise Docker Compose et Wrangler **local** pour
exécuter PgMailCryP, son pont SMTP et Stalwart ensemble. Il ne déploie rien sur
Cloudflare et ne modifie aucun DNS. Ce n’est pas une installation de production.
Chaque installation indique son propre domaine, sans valeur imposée.

Prérequis : Linux avec Docker Engine + Compose, Node.js 20.19+ pour l’installateur,
accès au registre des images et à npm, plusieurs Gio de RAM disponibles pour la
compilation (heap Node de 3 Gio), espace disque pour les dépendances/images.
Le runtime dans les conteneurs est Node 24, avec pnpm et Stalwart verrouillés par
version et digest. La construction peut demander plus de mémoire que l’exécution.

À partir de la branche contenant cet installateur :

```sh
node infra/local/install.mjs --domain VOTRE_DOMAINE --state "$HOME/.pgmailcryp-test"
```

L’installateur écrit un lien de premier démarrage dans `setup-url.txt` (0600).
Ouvrir ce lien via le tunnel SSH. Sur une installation vide, l’écran crée le
premier administrateur, une organisation de routage **local** et sa boîte
personnelle. Le domaine est celui fourni à l’installateur. Aucune vérification
DNS publique ni aucun appel Cloudflare n’est effectué. L’adresse de connexion
administrateur doit être extérieure au domaine et à ses sous-domaines.

Après connexion, le parcours de sécurité existant exige TOTP **et** une passkey.
Il conduit ensuite à `/admin/installation`, qui vérifie le pont authentifié et
l’authentification SMTP de Stalwart, puis propose de configurer la clé de la boîte
sur l’appareil. La sonde n’envoie aucun courriel et n’expose aucun secret SMTP.

`--test-accounts` crée facultativement Alice et Bob dans une installation vide,
pour le scénario automatisé. Leurs mots de passe aléatoires sont dans
`test-accounts.json` (0600). Aucun administrateur ni aucune clé OpenPGP n’est
créé par cette option. Des comptes existants verrouillent toujours le premier
démarrage : ils ne sont jamais remplacés ou élevés automatiquement. Le parcours
Doota initial reste disponible sur les installations non groupées.

Un échec ordinaire de création annule le compte et la réservation du domaine
pour permettre une nouvelle tentative. Une interruption brutale au milieu du
premier démarrage peut laisser une réservation ou un compte partiel ; le
parcours s’arrête alors et conserve les données. Inspecter et récupérer cette
instance via les outils d’administration locaux avant de réessayer, sans
supprimer aveuglément les utilisateurs ni relancer un seed. Il n’y a pas encore
de réparation automatique de ce cas.

Le dossier d’état est privé et doit être sauvegardé avec les volumes Docker. Ne
pas le publier, ni afficher ses secrets dans un ticket. Un second lancement
conserve les secrets et données. Changer le domaine ou le port exige un autre
dossier d’état. `--port` change le port de l’application (défaut 18787) ; le port
de gestion Stalwart est ce port + 22. Aucun port SMTP n’est publié sur l’hôte.
`--skip-build` réapplique uniquement la configuration avec l’image déjà construite ;
omettre cette option pour prendre en compte des changements de code.

L’application et l’API d’administration Stalwart sont liées à `127.0.0.1` sur
l’hôte ; les transports entre conteneurs partagent un espace réseau privé. Le
mode SMTP sans TLS est réservé à ces liaisons loopback isolées. L’installation
bloque les destinataires externes au domaine configuré. Aucune livraison sur
Internet ni validation publique de propriété DNS n’est effectuée.

Pour une machine distante, ouvrir un tunnel depuis son poste :

```sh
ssh -N -L 18787:127.0.0.1:18787 VOTRE_SERVEUR
```

Puis ouvrir `http://localhost:18787/pgmailcryp`. Utiliser deux profils de navigateur
et suivre le [parcours Alice/Bob](../../docs/pgmailcryp.md). `localhost` est
nécessaire pour le contexte sécurisé du navigateur ; ne pas utiliser l’adresse
IP distante en HTTP. Utiliser les paramètres propres à son installation.

Exploitation locale (remplacer le dossier si nécessaire) :

```sh
docker compose -f "$HOME/.pgmailcryp-test/compose.json" ps
docker compose -f "$HOME/.pgmailcryp-test/compose.json" logs --tail 50 app bridge
# Arrêt sans suppression des volumes ni des données :
docker compose -f "$HOME/.pgmailcryp-test/compose.json" stop
```

Les journaux Stalwart au premier démarrage peuvent contenir un secret de
bootstrap : les inspecter localement et ne pas les publier. Le mot de passe
administrateur définitif reste dans `stalwart-admin.json`. Le secret de récupération
provisoire est retiré de la configuration après bootstrap. La configuration JMAP
est propre à Stalwart 1.2.1 ; elle ne réutilise pas une ancienne configuration TOML.

Ce test n’active pas ACME, DKIM, le port public 25 ou un relais externe. Le passage
en production nécessite une autre étape d’installation et une validation TLS,
DNS, reprise de livraison et restauration. Un push GitHub ne met pas à jour cette
installation locale automatiquement.

Une seule machine suffit. Compose gère les composants internes et un espace
réseau stable, conservé lorsque l’application redémarre. Stalwart est téléchargé
comme composant officiel distinct, sous ses propres licences (Community :
[AGPL-3.0](https://github.com/stalwartlabs/stalwart/tree/v1.2.1/LICENSES)).

Test navigateur explicite contre une installation jetable, avec deux comptes :

```sh
PGP_TEST_ACCOUNTS=/chemin/prive/test-accounts.json \
PGP_TEST_BROWSER=/chemin/vers/firefox \
node apps/web/e2e/pgmailcryp.mjs
```

Le test conserve les clés privées **chiffrées sur le poste du navigateur**, dans
un fichier privé voisin de `PGP_TEST_ACCOUNTS`, pour pouvoir être relancé sans
remplacer les clés publiées. Ne pas copier ce fichier sur le serveur ni dans Git.
Les clés et la phrase de passe synthétiques du test ne servent pas en production.
Il vérifie les brouillons, le transport SMTP, la signature, les octets de pièce
jointe, la réponse et le transfert ; il surveille aussi les corps des appels
`fetch` pour détecter la fuite de ses marqueurs et de sa phrase de passe de test.

Le premier démarrage dispose d’un test distinct, uniquement contre une instance
jetable **vide**, sans `--test-accounts` :

```sh
INSTALL_TEST_SECRETS=/chemin/prive/installation-test.json \
PGP_TEST_BROWSER=/chemin/vers/firefox \
node apps/web/e2e/installation.mjs
```

Le fichier JSON privé fournit `url` (localhost via tunnel), `domain`, `token`
(SETUP_TOKEN), `email` (administrateur externe synthétique) et `password`.
Le test crée réellement cet administrateur et sa boîte `owner@domain` : il ne
supprime ni ne réinitialise les données après exécution. Il vérifie le blocage
MFA et le verrouillage du setup, sans enrôler une passkey matérielle. Les secrets
restent hors de Git. Une erreur de ressource limitée au favicon du service
worker préexistant est distinguée des erreurs de l’application.
