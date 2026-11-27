# Sauvegarde, restauration et mise à jour du serveur natif

Cette procédure concerne l’installation Docker native de test. Les anciens
pilotes Wrangler nécessitent une autre procédure ; l’outil les refuse.

## Créer une sauvegarde

Depuis le dépôt installé sur le serveur, avec Node 20.19+ et l’accès à Docker :

```sh
node infra/server/maintenance.mjs keygen --output /CHEMIN_PRIVE/recuperation.key
node infra/server/maintenance.mjs backup \
  --state /CHEMIN/ETAT \
  --output /CHEMIN_SAUVEGARDES/copie.pgm \
  --key-file /CHEMIN_PRIVE/recuperation.key
```

La clé est un fichier de 32 octets aléatoires, privé (`chmod 600`). Conserver
une copie hors du serveur, séparément des archives. **Sans cette clé, la
sauvegarde est irrécupérable.** L’archive et la clé doivent être à l’extérieur
du dossier d’état ; un fichier existant n’est jamais écrasé.

L’outil verrouille la maintenance, arrête successivement Stalwart, le pont et
l’application, copie leurs données, puis les redémarre avant le chiffrement
de la copie. Pendant cette interruption, les connexions SMTP ne sont pas
acceptées : le MTA expéditeur doit conserver et retenter la livraison. Les
erreurs de copie entraînent aussi une tentative de redémarrage automatique.
Les services doivent être en fonctionnement au début de l’opération.

La copie comprend :

- le dossier d’état complet : SQLite, objets, files de travaux, sessions,
  reçus SMTP, secrets et identifiants d’administration ;
- les volumes de configuration et de données Stalwart, dont ses files SMTP ;
- les versions des images et l’identifiant immuable de l’image applicative.

Le format utilise AES-256-GCM, avec un nonce aléatoire par archive. Un inventaire
authentifié contient les tailles et empreintes SHA-256 des fichiers. La copie
est vérifiée avant publication : intégrité SQLite, clés étrangères, références
OpenPGP, empreintes des objets et intégrité des reçus SMTP. L’archive peut
contenir des données SMTP ordinaires en attente dans Stalwart et des secrets
serveur ; son chiffrement reste nécessaire même si les messages applicatifs
sont chiffrés par OpenPGP.

Les clés privées OpenPGP, conservées sur les appareils, **ne font pas partie
de cette sauvegarde**. Chaque utilisateur doit conserver son export de secours
et sa phrase de passe pour pouvoir relire les messages après une restauration.

## Restaurer sans remplacer la source

Utiliser la même version du dépôt et disposer de l’image applicative d’origine
dans Docker. La sauvegarde conserve son identifiant mais ne contient pas les
images Docker elles-mêmes. Pour une récupération sur une autre machine, il faut
donc aussi exporter cette image avec `docker image save`, la conserver et la
charger avec `docker image load`. Les images Node et Stalwart sont verrouillées
dans `infra/local/versions.json` et doivent être disponibles localement ou dans
leurs registres. Ce prérequis demeure jusqu’à la publication d’images de release.
La commande de sauvegarde ou de mise à jour affiche l’identifiant de l’image à
conserver ; exporter cette image avant de supprimer d’anciennes images Docker.

```sh
docker image save --output /CHEMIN_SAUVEGARDES/application.tar sha256:IDENTIFIANT_AFFICHE
# Sur la machine de récupération :
docker image load --input /CHEMIN_SAUVEGARDES/application.tar
```

```sh
node infra/server/maintenance.mjs restore \
  --input /CHEMIN_SAUVEGARDES/copie.pgm \
  --state /CHEMIN/NOUVEL_ETAT \
  --key-file /CHEMIN_PRIVE/recuperation.key \
  --port 18801
docker compose -f /CHEMIN/NOUVEL_ETAT/compose.json up -d
```

Le dossier cible doit être absent. La restauration authentifie toute l’archive
avant d’extraire ses fichiers ; elle refuse les chemins sortant de la cible,
les liens et les doublons. Elle crée un projet et des volumes Docker distincts,
régénère les chemins et le port des configurations et rétablit le propriétaire
des fichiers attendu par l’image Stalwart. Elle vérifie les bases et objets
avant de laisser les services arrêtés. Un échec conserve la cible partiellement
restaurée pour inspection ; il ne démarre pas automatiquement cette copie.

Après démarrage, vérifier la connexion, la lecture de messages existants avec
la clé de l’appareil, puis une livraison avec pièce jointe. Ne faire basculer
aucun accès public avant ces vérifications. Le port HTTP et le port de gestion
Stalwart restent locaux ; aucun DNS ni service Internet n’est modifié.

## Mettre à jour avec une sauvegarde préalable

Après récupération de la version de code souhaitée :

```sh
node infra/server/maintenance.mjs upgrade \
  --state /CHEMIN/ETAT \
  --output /CHEMIN_SAUVEGARDES/avant-mise-a-jour.pgm \
  --key-file /CHEMIN_PRIVE/recuperation.key
```

L’outil sauvegarde l’ancienne installation, construit l’image applicative,
remplace l’application et le pont, puis attend la santé du serveur natif. Les
volumes Stalwart et le dossier d’état restent attachés à l’installation. Pour
une image déjà construite et validée localement, l’option `--image sha256:…`
utilise cet identifiant immuable au lieu de reconstruire.

La santé HTTP ne prouve pas la livraison SMTP : contrôler ensuite le transport
et un échange complet. En cas de problème, restaurer la sauvegarde dans un
nouveau dossier. Il n’y a pas de retour automatique à un ancien schéma après
migration.

Ne lancer aucune installation ou modification manuelle de configuration pendant
la maintenance. Un arrêt forcé du processus ou une panne peut laisser les
services arrêtés et `.maintenance-lock` présent. Vérifier qu’aucune opération
n’est encore active avant de retirer ce verrou, puis redémarrer les services
avec `docker compose -f /CHEMIN/ETAT/compose.json start app bridge stalwart`.
Les dossiers temporaires `.pgmailcryp-snapshot-*`, `.pgmailcryp-decrypt-*` et
`.pgmailcryp-restore-*` sont privés, mais peuvent contenir une copie déchiffrée
après un arrêt forcé ; les supprimer seulement après diagnostic et récupération.

## Validation du jalon

La restauration a été réalisée dans une instance distincte avec Stalwart réel.
Les empreintes des comptes, autorisations, clés publiques, messages et objets
correspondaient à celles de la source. Firefox a ensuite déchiffré l’historique
avec les clés restées sur l’appareil et validé un nouvel échange signé avec
pièce jointe binaire, réponse et transfert.

Le remplacement de l’image applicative par une image reconstruite a conservé
les empreintes des comptes et messages. Ce contrôle porte sur un remplacement
sans nouveau schéma ; chaque future migration doit être vérifiée séparément.
Pour reproduire le contrôle navigateur de l’historique, ajouter
`PGP_TEST_EXISTING_MESSAGES=1` à l’exécution de `apps/web/e2e/pgmailcryp.mjs`, avec
les identifiants de test privés et les sauvegardes locales de clés du test initial.

Ce test ne constitue pas une preuve de reprise de tous les états possibles
d’une file SMTP interrompue. Les essais de panne brutale, de disque plein et
de récupération sur une autre machine restent à étendre avant une release.
