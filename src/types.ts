// ============================================================================
// Property IDs
// ============================================================================

export const PropertyIds = {
  NOTIFICATION: 'P1',
  ON: 'P3',
  AVAILABLE: 'P5',
  BRIGHTNESS: 'P1501',
  COLOR_TEMP: 'P1502',
  CAMERA_SIREN: 'P1049',
  CAMERA_FLOOD_LIGHT: 'P1056',
} as const;

export type PropertyId = (typeof PropertyIds)[keyof typeof PropertyIds];

// ============================================================================
// Wall Switch Modes
// ============================================================================

export const WallSwitchMode = {
  CLASSIC: 1, // Classic Control
  IOT: 2, // Smart Control
} as const;

export type WallSwitchModeValue = (typeof WallSwitchMode)[keyof typeof WallSwitchMode];

// ============================================================================
// Color Properties
// ============================================================================

export const WyzeColorProperty = {
  WYZE_COLOR_TEMP_MIN: 2700,
  WYZE_COLOR_TEMP_MAX: 6500,
} as const;

export const HomeKitColorProperty = {
  HOMEKIT_COLOR_TEMP_MIN: 500,
  HOMEKIT_COLOR_TEMP_MAX: 140,
} as const;

// ============================================================================
// Thermostat Mappings
// ============================================================================

export const Wyze2HomekitUnits = {
  C: 0,
  F: 1,
} as const;

export const Wyze2HomekitStates = {
  off: 0,
  heat: 1,
  cool: 2,
  auto: 3,
} as const;

export const Wyze2HomekitWorkingStates = {
  idle: 0,
  heating: 1,
  cooling: 2,
} as const;

// ============================================================================
// Camera Commands
// ============================================================================

export const GetCommands = {
  state: null,
  power: null,
  update_snapshot: null,
  take_photo: 'K10058TakePhoto',
  irled: 'K10044GetIRLEDStatus',
  night_vision: 'K10040GetNightVisionStatus',
  status_light: 'K10030GetNetworkLightStatus',
  osd_timestamp: 'K10070GetOSDStatus',
  osd_logo: 'K10074GetOSDLogoStatus',
  camera_time: 'K10090GetCameraTime',
  night_switch: 'K10624GetAutoSwitchNightType',
  alarm: 'K10632GetAlarmFlashing',
  start_boa: 'K10148StartBoa',
  cruise_points: 'K11010GetCruisePoints',
  pan_cruise: 'K11014GetCruise',
  ptz_position: 'K11006GetCurCruisePoint',
  motion_tracking: 'K11020GetMotionTracking',
  motion_tagging: 'K10290GetMotionTagging',
  camera_info: 'K10020CheckCameraInfo',
  battery_usage: 'K10448GetBatteryUsage',
  rtsp: 'K10604GetRtspParam',
  accessories: 'K10720GetAccessoriesInfo',
  floodlight: 'K10788GetIntegratedFloodlightInfo',
  whitelight: 'K10820GetWhiteLightInfo',
  param_info: 'K10020CheckCameraParams',
  _bitrate: 'K10050GetVideoParam',
} as const;

export type GetCommandKey = keyof typeof GetCommands;

export const GetPayloadCommands = new Set<GetCommandKey>(['param_info']);

export const SetCommands = {
  state: null,
  power: null,
  time_zone: null,
  cruise_point: null,
  fps: null,
  bitrate: null,
  irled: 'K10046SetIRLEDStatus',
  night_vision: 'K10042SetNightVisionStatus',
  status_light: 'K10032SetNetworkLightStatus',
  osd_timestamp: 'K10072SetOSDStatus',
  osd_logo: 'K10076SetOSDLogoStatus',
  camera_time: 'K10092SetCameraTime',
  night_switch: 'K10626SetAutoSwitchNightType',
  alarm: 'K10630SetAlarmFlashing',
  rotary_action: 'K11002SetRotaryByAction',
  rotary_degree: 'K11000SetRotaryByDegree',
  reset_rotation: 'K11004ResetRotatePosition',
  cruise_points: 'K11012SetCruisePoints',
  pan_cruise: 'K11016SetCruise',
  ptz_position: 'K11018SetPTZPosition',
  motion_tracking: 'K11022SetMotionTracking',
  motion_tagging: 'K10292SetMotionTagging',
  hor_flip: 'K10052HorizontalFlip',
  ver_flip: 'K10052VerticalFlip',
  rtsp: 'K10600SetRtspSwitch',
  quick_response: 'K11635ResponseQuickMessage',
  spotlight: 'K10646SetSpotlightStatus',
  floodlight: 'K12060SetFloodLightSwitch',
  format_sd: 'K10242FormatSDCard',
} as const;

export type SetCommandKey = keyof typeof SetCommands;

export const CommandValues = {
  on: 1,
  off: 2,
  auto: 3,
  true: 1,
  false: 2,
  left: [-90, 0] as const,
  right: [90, 0] as const,
  up: [0, 90] as const,
  down: [0, -90] as const,
} as const;

export type CommandValueKey = keyof typeof CommandValues;

export const CameraParams = {
  status_light: '1',
  night_vision: '2',
  bitrate: '3',
  res: '4',
  fps: '5',
  hor_flip: '6',
  ver_flip: '7',
  motion_tagging: '21',
  time_zone: '22',
  motion_tracking: '27',
  irled: '50',
} as const;

export type CameraParamKey = keyof typeof CameraParams;

// ============================================================================
// API Types
// ============================================================================

export interface WyzeAPIOptions {
  username?: string;
  password?: string;
  mfaCode?: string;
  apiKey?: string;
  keyId?: string;
  persistPath?: string;
  refreshTokenTimerEnabled?: boolean;
  lowBatteryPercentage?: number;
  apiLogEnabled?: boolean;
  authBaseUrl?: string;
  apiBaseUrl?: string;
  // App emulation
  authApiKey?: string;
  phoneId?: string;
  appName?: string;
  appVer?: string;
  appVersion?: string;
  sc?: string;
  sv?: string;
  appInfo?: string;
  // Crypto secrets
  fordAppKey?: string;
  fordAppSecret?: string;
  oliveSigningSecret?: string;
  oliveAppId?: string;
}

export interface WyzeDevice {
  mac: string;
  nickname: string;
  product_model: string;
  product_type: string;
  device_params?: Record<string, unknown>;
  property_list?: WyzeProperty[];
  [key: string]: unknown;
}

export interface WyzeToken {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user_id?: string;
}

export interface WyzeApiResponse<T = unknown> {
  code: string;
  msg: string;
  data: T;
  ts?: number;
}

export interface WyzeProperty {
  pid: string;
  pvalue: string;
  ts: number;
}

export interface WyzeLockInfo {
  lockState: number;
  doorState: number;
  batteryLevel: number;
}

export interface WyzeHmsStatus {
  message_id: string;
  status: number;
}

export interface WyzeDeviceListResponse {
  device_list: WyzeDevice[];
}

export interface WyzePropertyListResponse {
  property_list: WyzeProperty[];
}

// ============================================================================
// Legacy exports (for backward compatibility)
// ============================================================================

export const propertyIds = PropertyIds;
export const wyzeWallSwitch = WallSwitchMode;
export const wyzeColorProperty = WyzeColorProperty;
export const homeKitColorProperty = HomeKitColorProperty;
export const wyze2HomekitUnits = Wyze2HomekitUnits;
export const wyze2HomekitStates = Wyze2HomekitStates;
export const wyze2HomekitWorkingStates = Wyze2HomekitWorkingStates;
export const GET_CMDS = GetCommands;
export const GET_PAYLOAD = GetPayloadCommands;
export const SET_CMDS = SetCommands;
export const CMD_VALUES = CommandValues;
export const PARAMS = CameraParams;
