# PgMailCryP

**Messagerie OpenPGP où la clé privée reste sur l’appareil de l’utilisateur.**

PgMailCryP est un fork en développement de Doota. Le projet conserve sa base
SvelteKit et ses services mail, mais remplace progressivement le chiffrement
connu du serveur par du chiffrement et du déchiffrement dans le navigateur.
Chaque installation utilise **son propre domaine**, fourni à la configuration.
Aucun domaine ni serveur personnel du développeur n’est imposé ou publié dans
la configuration d’installation.

> **État : développement et tests, pas encore une version de production.**
> Le parcours expérimental se trouve sur la branche
> [`codex/pgmailcryp-receive-pilot`](https://github.com/williamcadev/PgMailCryP/tree/codex/pgmailcryp-receive-pilot).
> `main` conserve les fondations et cette présentation ; le code expérimental
> et son installateur sont sur la branche ci-dessus.

## Ce qui change par rapport à Doota

Doota chiffre les messages au repos avec `MAIL_DEK`, un secret disponible dans
les Workers. Ce mécanisme protège des copies de stockage, mais le serveur peut
encore déchiffrer les données : il ne suffit pas pour l’objectif PgMailCryP.

Le parcours expérimental ajoute :

- génération et import de clés OpenPGP dans le navigateur ;
- protection de la clé privée par une phrase de passe et sauvegarde locale
  chiffrée, avec export de secours ;
- publication de la clé publique d’une boîte personnelle autorisée ;
- réception séparée : MIME et pièces jointes sont chiffrés avec cette clé
  publique avant stockage, sans copie de contenu dans l’index de recherche ;
- lecture et déchiffrement sur l’appareil, téléchargement des pièces jointes et
  export du message ;
- endpoint Stalwart authentifié, validation des entrées et erreurs permettant
  les nouvelles tentatives de livraison ;
- composition et signature sur l’appareil, chiffrement de l’objet, du corps et
  des pièces jointes avant envoi ;
- brouillons chiffrés locaux et synchronisés, copies envoyées, réponse et
  transfert par le parcours OpenPGP ;
- vérification des signatures avec des clés de contacts dont les empreintes
  sont comparées indépendamment.

Les boîtes partagées sont exclues de ce pilote : elles nécessitent une gestion
multi-clés. Les anciens messages et les chemins Doota non remplacés restent
soumis aux garanties Doota.

## Parcours complet expérimental

La branche relie les étapes suivantes :

1. Composer et signer sur l’appareil ; chiffrer l’objet, le corps et les pièces
   jointes avant toute transmission au serveur.
2. Conserver les brouillons chiffrés, sans corps ni noms de pièces jointes
   lisibles dans les sauvegardes de composition.
3. Envoyer le MIME OpenPGP via un transport SMTP, avec états et tentatives
   durables par destinataire.
4. Recevoir le courriel, stocker sa copie chiffrée, puis déchiffrer les couches
   PGP/MIME et vérifier la signature dans le navigateur.
5. Lire la copie envoyée, répondre et transférer par le même parcours chiffré.

Il s’agit d’un jalon de test, sans release de production. Les limites et les
contrats de stockage/transport sont détaillés dans [la documentation technique](https://github.com/williamcadev/PgMailCryP/blob/codex/pgmailcryp-receive-pilot/docs/pgmailcryp.md).

## Installation groupée : PgMailCryP + Stalwart

**Stalwart doit être installé avec le serveur PgMailCryP et préconfiguré pour
communiquer avec lui.** Le pont SMTP fait partie de cet ensemble ; son raccordement
ne doit pas être une étape laissée à deviner après l’installation.

Chaque installation utilise le serveur choisi par son administrateur. L’ensemble
regroupe l’application, Stalwart, le pont authentifié, les secrets de
communication générés localement et un test de livraison.

La base Doota utilise actuellement Workers, D1, R2, KV et Queues. Elle ne devient
pas une application Linux autonome par une simple copie des sources. Le
regroupement de test utilise Wrangler local dans Docker pour ces ressources,
sans compte Cloudflare. Il ne configure ni MX ni autre DNS.

### Installer la version de test isolée

Prérequis : Linux, Docker Engine + Compose, Node.js 20.19+ pour l’installateur,
accès aux registres et plusieurs Gio de mémoire disponibles pour construire.
Le runtime conteneurisé fournit Node 24 et pnpm à la version verrouillée.

```sh
git clone --branch codex/pgmailcryp-receive-pilot https://github.com/williamcadev/PgMailCryP.git
cd PgMailCryP
node infra/local/install.mjs --domain VOTRE_DOMAINE --state "$HOME/.pgmailcryp-test" --test-accounts
```

Les comptes de test facultatifs Alice et Bob sont créés uniquement dans une
instance vide, avec des mots de passe aléatoires dans son dossier privé. Chaque
utilisateur crée sa clé OpenPGP **dans son navigateur**. L’installation conserve
ses secrets et volumes lors d’un nouveau lancement.

Depuis son poste, pour accéder au serveur distant :

```sh
ssh -N -L 18787:127.0.0.1:18787 VOTRE_SERVEUR
```

Ouvrir ensuite `http://localhost:18787/pgmailcryp`. Remplacer `VOTRE_SERVEUR` et
`VOTRE_DOMAINE` par les valeurs propres à cette installation.
Les ports sont liés au loopback, les transports internes sont préconfigurés et
les destinataires externes sont bloqués. Aucun envoi Internet n’est activé.
Consulter [le guide d’installation](https://github.com/williamcadev/PgMailCryP/blob/codex/pgmailcryp-receive-pilot/infra/local/README.md)
pour les identifiants, les profils de navigateur, l’arrêt et les limites.

Pour vérifier les sources avec Node.js 22.18+ et pnpm 11.29.0 :

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
node --test infra/local/render.test.mjs
```

## Ce que le serveur peut encore voir

**Courriel ordinaire :** si l’auteur l’envoie sans chiffrement OpenPGP, le premier
serveur SMTP reçoit son contenu lisible. Le chiffrer après réception protège le
stockage mais ne supprime pas cet accès pendant l’ingress. TLS protège la liaison,
pas contre le serveur qui la termine.

**Courriel chiffré avant envoi :** le corps et les pièces jointes peuvent rester
illisibles aux serveurs SMTP. L’enveloppe d’expédition et de destination, la
taille, les horaires et certains en-têtes externes restent visibles. L’objet ne
doit pas être supposé protégé avec tous les clients externes.

Déplacer le chiffrement de réception vers Stalwart pourrait cacher le clair aux
Workers, mais Stalwart le verrait encore. **Aucune garantie zero-access globale
n’est annoncée** tant que réception, stockage, lecture, pièces jointes,
brouillons, copies envoyées et caches ne sont pas tous couverts et vérifiés.
Le code du navigateur fourni par le serveur reste également un élément de
confiance ; les empreintes des clés doivent être comparées indépendamment.

## Informations d’exploitation nécessaires

- **À fournir pour chaque installation :** son domaine, ses noms d’hôtes, son
  serveur et ses paramètres DNS. Aucun compte, domaine ou secret de notre
  instance de test ne doit être repris automatiquement.
- **Cloudflare :** compte et zone cibles, URL de l’application et ressources
  réservées aux tests ; authentification via les outils ou secrets locaux.
- **Stalwart :** version et image verrouillées par l’installation, routage SMTP
  vers le pont PgMailCryP, acquittements et nouvelles tentatives conservés.
- **Envoi externe éventuel :** fournisseur du relais, hôte, port, TLS et adresses
  autorisées. Le raccordement dépendra du transport retenu.

Ne jamais commiter de token Cloudflare, de mot de passe SMTP, de clé privée
OpenPGP ou de phrase de passe. La clé privée OpenPGP n’est pas un secret à
installer sur le serveur.

## GitHub et déploiements

Un push sur la branche expérimentale ne déclenche pas le workflow de déploiement
Cloudflare du dépôt. Le workflow Doota hérité cible `main` et propose aussi un
déclenchement manuel ; les mises à jour de présentation seules utilisent
`[skip ci]`. Les éventuels Workers Builds se vérifient séparément dans le compte
Cloudflare. L’installation locale n’est pas mise à jour automatiquement par un
push GitHub.

## Origine et licence

PgMailCryP s’appuie sur Doota, projet d’Ethercorps, sous licence Apache-2.0.
La [documentation Doota d’origine](DOOTA_UPSTREAM_README.md) est conservée
séparément pour référence. Ses fonctions, domaines et garanties historiques
ne décrivent pas automatiquement PgMailCryP.
