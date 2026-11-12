# One spelling for a constraint pg_dump can print two ways, applied to both sides before
# two schema dumps are compared (sed -E -f; regen-init-sql.sh and check-migrations.sh).
#
# Postgres keeps CHECK (col IN ('a', 'b')) on a varchar column, as a migration creates it, as
#   (col)::text = ANY ((ARRAY['a'::character varying, ...])::text[])
# and prints the same constraint, created again from that text (init.sql, a dump reloaded), as
#   (col)::text = ANY (ARRAY[('a'::character varying)::text, ...])
# One check written two ways: both become (col)::text = ANY (ARRAY['a'::character varying, ...]).
# A different list of values still differs.
s/\(('([^']|'')*'::character varying)\)::text/\1/g
s/ANY \(\(ARRAY\[([^]]*)\]\)::text\[\]\)/ANY (ARRAY[\1])/g
