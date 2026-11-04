-- Temporary, isolated fixture; no persistent table or sequence is touched.
CREATE TEMP TABLE nodes (
    id bigint NOT NULL,
    ip character varying(255) NOT NULL,
    port integer,
    country text,
    country_code character varying(2),
    city text,
    lat double precision,
    lon double precision,
    isp text,
    inbound boolean,
    ping_ms double precision,
    is_tor boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    user_agent character varying(255),
    client_impl character varying(64) DEFAULT 'Unknown'::character varying NOT NULL,
    client_version character varying(64),
    protocol_version integer,
    observed_via character varying(16) DEFAULT 'peer'::character varying NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT nodes_lat_valid CHECK (((lat IS NULL) OR ((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision)))),
    CONSTRAINT nodes_lon_valid CHECK (((lon IS NULL) OR ((lon >= ('-180'::integer)::double precision) AND (lon <= (180)::double precision)))),
    CONSTRAINT nodes_observed_via_valid CHECK (((observed_via)::text = ANY ((ARRAY['peer'::character varying, 'dns'::character varying, 'crawl'::character varying])::text[]))),
    CONSTRAINT nodes_port_valid CHECK (((port IS NULL) OR ((port >= 1) AND (port <= 65535))))
);
CREATE TEMP TABLE node_snapshots (
    id bigint NOT NULL,
    snapshot_time timestamp with time zone DEFAULT now() NOT NULL,
    active_nodes integer DEFAULT 0 NOT NULL,
    total_nodes integer DEFAULT 0 NOT NULL,
    countries integer DEFAULT 0 NOT NULL,
    tor_nodes integer DEFAULT 0 NOT NULL,
    inbound_nodes integer DEFAULT 0 NOT NULL,
    outbound_nodes integer DEFAULT 0 NOT NULL,
    avg_ping_ms double precision,
    identified_client_nodes integer DEFAULT 0 NOT NULL,
    client_counts jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE nodes ADD COLUMN onion_address text, ADD COLUMN tor_type text,
ADD COLUMN betweenness double precision, ADD COLUMN closeness double precision,
ADD COLUMN degree integer, ADD COLUMN network_type text, ADD COLUMN start_height bigint,
ADD COLUMN services bigint, ADD COLUMN crawl_seen_count integer DEFAULT 0,
ADD COLUMN crawl_miss_count integer DEFAULT 0, ADD COLUMN last_verified_at timestamptz,
ADD COLUMN last_peer_seen_at timestamptz, ADD COLUMN last_chain_verified_at timestamptz,
ADD COLUMN chain_block_hash text, ADD COLUMN chain_proof text;
ALTER TABLE node_snapshots ADD COLUMN tor_hidden_nodes integer DEFAULT 0,
ADD COLUMN census_version smallint NOT NULL DEFAULT 0;
CREATE TEMP TABLE node_edges(src_addr_id bigint, dst_addr_id bigint, observed_at timestamptz DEFAULT now(), UNIQUE(src_addr_id,dst_addr_id));
CREATE TEMP TABLE node_metrics(addr_id bigint,betweenness double precision,closeness double precision,degree int,network_type text);

CREATE TEMP TABLE topology_nodes (
    addr         TEXT PRIMARY KEY,              -- "ip:port" — server-side identity, never exposed
    ip           TEXT NOT NULL,                 -- for geo/Tor detection and join to nodes
    reachable    BOOLEAN NOT NULL,              -- true = completed handshake; false = gossiped/unreachable ("off")
    client_impl  TEXT,                          -- Zebra/Zakura/zcashd/Unknown (from crawler user-agent; reachable only)
    is_tor       BOOLEAN NOT NULL DEFAULT FALSE,
    country_code TEXT,
    lat          DOUBLE PRECISION,
    lon          DOUBLE PRECISION,
    degree       INTEGER NOT NULL DEFAULT 0,
    betweenness  DOUBLE PRECISION,
    closeness    DOUBLE PRECISION,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TEMP TABLE topology_edges (
    src TEXT NOT NULL,                           -- topology_nodes.addr
    dst TEXT NOT NULL,                           -- topology_nodes.addr
    PRIMARY KEY (src, dst)
);
