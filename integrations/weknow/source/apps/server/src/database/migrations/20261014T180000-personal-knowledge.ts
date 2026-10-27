import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>) {
  await sql`create unique index personal_space_owner_unique on spaces(workspace_id, creator_id) where is_personal and deleted_at is null`.execute(
    db,
  );
  await sql`alter table spaces add constraint personal_space_owner_required check (not is_personal or creator_id is not null)`.execute(
    db,
  );
  await db.schema
    .createTable('personalHandoffs')
    .addColumn('sourceSpaceId', 'uuid', (c) =>
      c.primaryKey().references('spaces.id').onDelete('restrict'),
    )
    .addColumn('userId', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('workspaceId', 'uuid', (c) =>
      c.notNull().references('workspaces.id').onDelete('restrict'),
    )
    .addColumn('memberName', 'text', (c) => c.notNull())
    .addColumn('reason', 'varchar(32)', (c) => c.notNull())
    .addColumn('state', 'varchar(16)', (c) => c.notNull().defaultTo('pending'))
    .addColumn('recipientId', 'uuid')
    .addColumn('folderId', 'uuid')
    .addColumn('pageCount', 'integer')
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('errorCode', 'varchar(64)')
    .addColumn('createdAt', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('finishedAt', 'timestamptz')
    .execute();
  // Defence in depth: a stale client or a future grant endpoint cannot make a
  // personal space public or grant another user/group access.
  await sql
    .raw(
      `
    create function protect_personal_space_grants() returns trigger language plpgsql as $$
    declare s spaces;
    begin
      select * into s from spaces where id = new.space_id for share;
      if s.is_personal then
        if TG_TABLE_NAME = 'space_members' then
          if new.user_id is distinct from s.creator_id or new.group_id is not null or new.role <> 'admin' then
            raise exception 'Personal spaces only allow their owner' using errcode='23514';
          end if;
        else
          raise exception 'Personal spaces cannot be published' using errcode='23514';
        end if;
      end if;
      return new;
    end $$;
    create trigger personal_members_guard before insert or update on space_members for each row execute function protect_personal_space_grants();
    create trigger personal_shares_guard before insert or update on shares for each row execute function protect_personal_space_grants();
    create trigger personal_public_guard before insert or update on public_spaces for each row execute function protect_personal_space_grants();
    create function protect_personal_space_owner() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'UPDATE' and new.is_personal is distinct from old.is_personal then
        raise exception 'Personal space kind is immutable' using errcode='23514';
      end if;
      if old.is_personal then
        if TG_OP = 'DELETE' then raise exception 'Personal space data must be retained' using errcode='23514'; end if;
        if not new.is_personal or new.creator_id is distinct from old.creator_id or new.workspace_id <> old.workspace_id then
          raise exception 'Personal space ownership is immutable' using errcode='23514';
        end if;
      end if;
      if TG_OP = 'DELETE' then return old; end if;
      return new;
    end $$;
    create trigger personal_owner_guard before update or delete on spaces for each row execute function protect_personal_space_owner();
    create function protect_personal_page_location() returns trigger language plpgsql as $$
    declare s spaces;
    begin
      select * into s from spaces where id = new.space_id for share;
      if s.is_personal and s.deleted_at is not null then
        raise exception 'Personal space has been archived' using errcode='23514';
      end if;
      return new;
    end $$;
    create trigger personal_page_location_guard before insert or update of space_id on pages for each row execute function protect_personal_page_location();
  `,
    )
    .execute(db);
}
export async function down(_db: Kysely<any>) {
  throw new Error(
    'Personal knowledge privacy guards must be retained on rollback. Stop the app and restore the pre-release database snapshot, or deploy a forward fix.',
  );
}
