const STATUS_ZONE_KEYS = ['working', 'offwork', 'remote', 'vacation'];

const DEFAULT_STATUS_ROOM_MAPPING = {
  labels: ['근무중', '퇴근중', '재택근무중', '휴가중'],
  slotByStatus: {
    working: 0,
    offwork: 1,
    remote: 2,
    vacation: 3,
  },
  updatedAt: null,
};

function clampSlot(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

function normalizeStatusRoomMapping(input = {}) {
  const labels = Array.isArray(input?.labels)
    ? input.labels.slice(0, 4)
    : DEFAULT_STATUS_ROOM_MAPPING.labels;

  return {
    labels,
    slotByStatus: {
      working: clampSlot(input?.slotByStatus?.working, DEFAULT_STATUS_ROOM_MAPPING.slotByStatus.working),
      offwork: clampSlot(input?.slotByStatus?.offwork ?? input?.slotByStatus?.idle, DEFAULT_STATUS_ROOM_MAPPING.slotByStatus.offwork),
      remote: clampSlot(input?.slotByStatus?.remote, DEFAULT_STATUS_ROOM_MAPPING.slotByStatus.remote),
      vacation: clampSlot(input?.slotByStatus?.vacation, DEFAULT_STATUS_ROOM_MAPPING.slotByStatus.vacation),
    },
    updatedAt: input?.updatedAt || null,
  };
}

module.exports = {
  STATUS_ZONE_KEYS,
  DEFAULT_STATUS_ROOM_MAPPING,
  normalizeStatusRoomMapping,
};
