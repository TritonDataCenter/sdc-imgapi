This is a first stab at UFDS sdcimage migrations for image validation changes. 

The correct next steps would be:

- Add an internal 'v' field on sdcimage objects that is a single
  integer giving the db record version. Key off that for migrations.
- Migrations must be idempotent.
- Have some easy entry point to trigger migrations.

Cross that road, when ...
