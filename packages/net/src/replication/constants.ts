/** The sole application replication protocol version published by net. */
export const REPLICATION_PROTOCOL_VERSION = 2;

/** Fixed wire prefix used to reject non-v2 replication bytes before dispatch. */
export const REPLICATION_PROTOCOL_PREFIX = 'FXRP2';
