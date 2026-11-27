# Serveur natif expérimental

Les nouvelles installations groupées démarrent SvelteKit sous Node 24 avec
SQLite et Stalwart. Cloudflare et Wrangler ne sont pas nécessaires à ce
parcours. Le backend Cloudflare reste disponible pour les déploiements Doota
existants ; il n’est pas automatiquement converti.

## Persistance

Le dossier d’état contient `native/mail.sqlite`, ses fichiers WAL et les objets
dans `native/objects`. SQLite conserve les comptes, clés publiques, références
de messages chiffrés, sessions et travaux de livraison. Les objets sont écrits
dans des fichiers immuables avant l’enregistrement de leur référence. Les
travaux utilisent des baux renouvelables et des jetons empêchant un ancien
traitement d’acquitter une nouvelle tentative. Les échecs épuisés restent en
base pour diagnostic ; ils ne sont pas supprimés silencieusement.

Le pont conserve aussi ses reçus SQLite dans le dossier d’état. Stalwart possède
deux volumes Docker distincts pour sa configuration et ses données. Sauvegarder
seulement `mail.sqlite` ne sauvegarde donc pas l’installation complète. Une
copie brute pendant des écritures n’est pas une procédure de sauvegarde validée.

Les migrations SQL applicatives existantes sont appliquées avec contrôle des
clés étrangères et empreinte de leur historique. Un changement d’une migration
déjà appliquée arrête le démarrage. L’installateur refuse de changer le runtime
d’un ancien pilote sans conversion explicite et vérifiée.

## Limites actuelles

- Installation isolée : HTTP sur une adresse locale, aucun SMTP public ni DNS
  configuré, destinataires limités au domaine de test.
- Sauvegarde/restauration complète et migration depuis Wrangler à terminer.
- Envoi des notifications transactionnelles du backend natif à raccorder ;
  une erreur explicite empêche le repli historique qui journalise les messages.
- Anciennes versions d’objets conservées : collecte des fichiers inutilisés,
  quotas et gestion du disque plein à compléter.
- Les opérations conditionnelles du stockage objet ne sont pas implémentées ;
  elles échouent explicitement. Les chemins actuellement utilisés n’en dépendent
  pas.
- HTTPS et transport SMTP Internet restent à valider avant ouverture publique.

Ce changement de runtime n’étend pas les garanties OpenPGP : le serveur voit
toujours le SMTP ordinaire entrant avant chiffrement et les métadonnées de
routage. Les anciens messages, boîtes partagées et chemins Doota non remplacés
ne bénéficient pas du parcours expérimental. Les clés privées restent sur les
appareils. Ce jalon ne constitue pas une garantie globale de zero-access.

## Vérifications reproductibles

```sh
pnpm check
pnpm test
pnpm --filter @pgmailcryp/server check
node --test infra/local/render.test.mjs
```

Les tests natifs appliquent les migrations réelles, vérifient les requêtes
Drizzle, les transactions, les fichiers binaires, l’expiration des sessions et
la reprise des travaux après réouverture. Le parcours navigateur explicite
`apps/web/e2e/pgmailcryp.mjs` doit être lancé contre une installation jetable,
avec ses identifiants de test privés et un navigateur local. Il teste les
signatures, les pièces jointes et les réponses/transferts livrés par SMTP.

Validation effectuée le 27 novembre 2026 : construction Docker native et
installation groupée avec Stalwart, puis parcours Firefox complet via un
tunnel SSH. Après redémarrage de l’application, du pont et de Stalwart, les
empreintes des comptes, autorisations, clés publiques, messages et références
d’objets étaient identiques ; chaque fichier référencé correspondait à son
empreinte et `PRAGMA quick_check` renvoyait `ok`. Ce contrôle de redémarrage ne
remplace pas un test de restauration d’une sauvegarde complète.
