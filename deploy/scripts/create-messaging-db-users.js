// Creates helium-backend's database users on the existing DocumentDB cluster (F24). Run once per environment
// by someone with an admin user, from a machine that can reach the cluster (a bastion or the VPN):
//
//   BACKEND_PASSWORD='<new strong password>' mongosh "<admin connection string>" --file deploy/scripts/create-messaging-db-users.js
//
// It creates (or updates the roles of) one user, `helium-backend`, with:
//   - read on `helium` (today's database, owned by the storefront): the backend never writes there (R9);
//   - readWrite on `helium_messaging`, the database this backend owns. It is created by the first migration.
// Later, the messaging migration (M8) needs write access to the legacy WhatsApp collections in `helium`; that is
// a separate, narrower grant recorded in its own ADR, not something to add here.
//
// Then build the two connection strings and store them in Secrets Manager (helium/<env>/mongo-main-uri and
// helium/<env>/mongo-messaging-uri); docs/RUNBOOK.md shows the format.

/* global db, print */
const user = 'helium-backend';
const password = process.env.BACKEND_PASSWORD;
if (!password || password.length < 24) {
  throw new Error('Set BACKEND_PASSWORD to a strong password of 24 characters or more');
}

const roles = [
  { role: 'read', db: 'helium' },
  { role: 'readWrite', db: 'helium_messaging' },
];

const admin = db.getSiblingDB('admin');
if (admin.getUser(user)) {
  admin.updateUser(user, { pwd: password, roles });
  print(`Updated ${user}: password and roles`);
} else {
  admin.createUser({ user, pwd: password, roles });
  print(`Created ${user}`);
}
print(JSON.stringify(admin.getUser(user).roles));
