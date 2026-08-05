--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."audit log" (
    id bigint NOT NULL,
    at timestamp without time zone NOT NULL,
    ok boolean
);


ALTER TABLE public."audit log" OWNER TO postgres;

--
-- Name: audit log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public."audit log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."audit log_id_seq" OWNER TO postgres;

--
-- Name: audit log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public."audit log_id_seq" OWNED BY public."audit log".id;


--
-- Name: user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."user" (
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    opens_at timestamp without time zone NOT NULL,
    billing_day timestamp(3) without time zone,
    label text
);


ALTER TABLE public."user" OWNER TO postgres;

--
-- Name: v; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v AS
 SELECT id,
    created_at
   FROM public."user";


ALTER VIEW public.v OWNER TO postgres;

--
-- Name: audit log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."audit log" ALTER COLUMN id SET DEFAULT nextval('public."audit log_id_seq"'::regclass);


--
-- Name: audit log audit log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."audit log"
    ADD CONSTRAINT "audit log_pkey" PRIMARY KEY (id);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- PostgreSQL database dump complete
--


