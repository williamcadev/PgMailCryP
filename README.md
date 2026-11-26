# PgMailCryP

**Messagerie OpenPGP où la clé privée reste sur l’appareil de l’utilisateur.**

PgMailCryP est un fork en développement de Doota. Le projet conserve sa base
SvelteKit et ses services mail, mais remplace progressivement le chiffrement
connu du serveur par du chiffrement et du déchiffrement dans le navigateur.
Le domaine du projet est **`anonyme.here`**, dont le DNS est géré par Cloudflare.

> **État : développement et tests, pas encore une version de production.**
> Le pilote publié se trouve sur la branche
> [`codex/pgmailcryp-receive-pilot`](https://github.com/williamcadev/PgMailCryP/tree/codex/pgmailcryp-receive-pilot).
> `main` contient encore les fondations. Le parcours complet d’envoi et
> l’installation groupée avec Stalwart sont en cours de finalisation.

## Ce qui change par rapport à Doota

Doota chiffre les messages au repos avec `MAIL_DEK`, un secret disponible dans
les Workers. Ce mécanisme protège des copies de stockage, mais le serveur peut
encore déchiffrer les données : il ne suffit pas pour l’objectif PgMailCryP.

Le pilote publié ajoute :

- génération et import de clés OpenPGP dans le navigateur ;
- protection de la clé privée par une phrase de passe et sauvegarde locale
  chiffrée, avec export de secours ;
- publication de la clé publique d’une boîte personnelle autorisée ;
- réception séparée : MIME et pièces jointes sont chiffrés avec cette clé
  publique avant stockage, sans copie de contenu dans l’index de recherche ;
- lecture et déchiffrement sur l’appareil, téléchargement des pièces jointes et
  export du message ;
- endpoint Stalwart authentifié, validation des entrées et erreurs permettant
  les nouvelles tentatives de livraison.

Les boîtes partagées sont exclues de ce pilote : elles nécessitent une gestion
multi-clés. Les anciens messages et les chemins Doota non remplacés restent
soumis aux garanties Doota.

## Parcours complet en cours de finalisation

Le prochain jalon relie les étapes suivantes :

1. Composer et signer sur l’appareil ; chiffrer l’objet, le corps et les pièces
   jointes avant toute transmission au serveur.
2. Conserver les brouillons chiffrés, sans corps ni noms de pièces jointes
   lisibles dans les sauvegardes de composition.
3. Envoyer le MIME OpenPGP via un transport SMTP, avec états et tentatives
   durables par destinataire.
4. Recevoir le courriel, stocker sa copie chiffrée, puis déchiffrer les couches
   PGP/MIME et vérifier la signature dans le navigateur.
5. Lire la copie envoyée, répondre et transférer par le même parcours chiffré.

Ce jalon n’est pas encore publié comme une release installable. Il ne faut pas
confondre les fonctions présentes sur la branche du pilote avec celles qui
sont encore en cours de validation.

## Installation groupée : PgMailCryP + Stalwart

**Stalwart doit être installé avec le serveur PgMailCryP et préconfiguré pour
communiquer avec lui.** Le pont SMTP fait partie de cet ensemble ; son raccordement
ne doit pas être une étape laissée à deviner après l’installation.

La machine de test retenue est **Lenovo**, accessible par `ssh lenovo`. La cible
prévue regroupe l’application, Stalwart, le pont authentifié, les secrets de
communication générés localement et un test de livraison.

La base Doota utilise actuellement Workers, D1, R2, KV et Queues. Elle ne devient
pas une application Linux autonome par une simple copie des sources. La
préparation d’un environnement local isolé pour Lenovo est en cours. Aucun MX
ni autre DNS d’`anonyme.here` n’est modifié par ces travaux.

### Tester le pilote publié maintenant

Prérequis : Node.js 22.18+ et pnpm à la version indiquée par `packageManager` sur
la branche du pilote.

```sh
git clone --branch codex/pgmailcryp-receive-pilot https://github.com/williamcadev/PgMailCryP.git
cd PgMailCryP
pnpm install --frozen-lockfile
pnpm --filter doota gen
pnpm --filter doota exec vitest run src/test/pgp-ingress.test.ts
pnpm test
```

Ces tests utilisent SQLite en mémoire et des doublures de stockage et de file.
Ils ne constituent pas à eux seuls une installation SMTP réelle. Pour le détail
du pilote, consulter [sa documentation sur la branche correspondante](https://github.com/williamcadev/PgMailCryP/blob/codex/pgmailcryp-receive-pilot/docs/pgmailcryp.md).

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

- **Connues :** domaine `anonyme.here`, DNS Cloudflare, serveur de test Lenovo.
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

Le workflow Doota hérité peut déployer Cloudflare après un push sur `main`, ou
sur déclenchement manuel. La publication de documentation n’est pas une
installation du pilote. Les déclencheurs Cloudflare Workers Builds éventuels
se vérifient séparément dans le compte Cloudflare.

## Origine et licence

PgMailCryP s’appuie sur Doota, projet d’Ethercorps, sous licence Apache-2.0.
La [documentation Doota d’origine](DOOTA_UPSTREAM_README.md) est conservée
séparément pour référence. Ses fonctions, domaines et garanties historiques
ne décrivent pas automatiquement PgMailCryP.
