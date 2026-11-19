-- Places d'une machine réglables dans Essaim (page de la machine), et ressources relevées par son runner.
ALTER TABLE machines ADD COLUMN base_capacity INTEGER;      -- CAPACITY du runner (sa valeur par défaut)
ALTER TABLE machines ADD COLUMN capacity_override INTEGER;  -- places choisies dans Essaim (NULL = CAPACITY)
ALTER TABLE machines ADD COLUMN capacity_until TEXT;        -- échéance du réglage (NULL = sans limite)
ALTER TABLE machines ADD COLUMN resources TEXT;             -- JSON : lib/machine.ts, MachineResources
