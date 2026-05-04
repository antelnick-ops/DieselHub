alter table chat_logs add column if not exists products_returned integer default 0;
alter table chat_logs add column if not exists lookup_query text;
