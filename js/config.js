/* ============================================================
 * config.js —— 全局可调参数（浏览器 window.RacerConfig）
 * 物理手感 / 氮气系统 / 赛道尺寸 / 联机频率 全部集中在这里
 * ============================================================ */
(function (root) {
  'use strict';

  const CONFIG = {
    /* ---- 赛道 ---- */
    ROAD_WIDTH: 16,            // 路面全宽（米）
    SAMPLE_STEP: 2.2,          // 中心线采样步长（米），越小越平滑
    CP_COUNT: 12,              // 检查点数量（计圈防作弊用）
    LAPS: 3,                   // 默认圈数
    RAIL_MARGIN: 0.9,          // 车身半宽近似：|lat| 超过 半宽-此值 撞护栏

    /* ---- 车辆物理（赛道空间）---- */
    MAX_SPEED: 46,             // 平速极速 m/s（≈165 km/h 显示再放大）
    SPEED_DISPLAY: 3.6,        // m/s → km/h
    ACCEL: 26,                 // 油门加速度
    BRAKE: 38,                 // 刹车减速度
    DRAG: 0.55,                // 速度阻力（线性系数，随速度衰减）
    REVERSE_MAX: 8,            // 倒车极速
    STEER_RATE: 2.0,           // 基础转向角速度 rad/s（持续角速度，非一次性偏角）
    STEER_FADE: 0.06,          // 高速转向衰减系数（越大高速越稳）
    STEER_ATTACK: 5.0,         // 转向输入上升速率 /s（键盘平滑，满舵约 0.2s）
    STEER_RELEASE: 7.5,        // 转向回正速率 /s
    HEADING_DAMP: 1.1,         // 打舵时车头自阻尼（保留转向权威）
    HEADING_ASSIST_RATE: 3.0,  // 松方向时循迹伺服角速度 rad/s（车头主动对齐切线）
    COURSE_ASSIST_FREE: 2.5,   // 松方向时航迹角辅助（出弯残余滑移快速收敛）
    GRIP: 8.0,                 // 抓地：航迹角追踪车头的速率（转弯时轨迹跟着车头弯）
    DRIFT_GRIP: 2.8,           // 漂移中航迹追踪速率（小=甩尾滑移大）
    DRIFT_HEADING_DAMP: 0.5,   // 漂移中车头自阻尼（小=车头能甩出去保持住）
    DRIFT_STEER_BOOST: 1.6,    // 漂移中转向增益
    DRIFT_ENTER_SPD: 14,       // 最低漂移触发速度
    DRIFT_BODY_YAW: 0.35,      // 漂移时车模额外偏转角（弧度，观感"偏移"）
    WALL_BOUNCE: 0.68,         // 撞墙速度保留比例
    WALL_REL_KEEP: 0.5,        // 撞墙反弹：车头/航迹角反射保留比例
    WALL_REL_KICK: -0.35,      // （兼容保留）撞墙 rel 反弹系数

    /* ---- 氮气系统 ---- */
    NITRO_MAX: 100,            // 集满 = 1 罐
    NITRO_GAIN_RATE: 36,       // 漂移集氮速率 /s（随速度比例缩放）
    NITRO_GAIN_MIN_SPD: 8,     // 低于此速度不集氮
    NITRO_GAIN_FLOOR: 0.55,    // 速度系数下限（低速漂移也能集氮）
    NITRO_CHARGES_MAX: 2,      // 最多存 2 罐
    NITRO_BOOST_TIME: 2.4,     // 每罐持续时间 s
    NITRO_MAX_MULT: 1.45,      // 喷射时极速倍率
    NITRO_ACCEL_MULT: 2.2,     // 喷射时加速度倍率
    AIR_BOOST_SPD: 9,          // 空喷前冲速度增量
    AIR_BOOST_VY: 2.4,         // 空喷轻微上抬
    AIR_BOOST_TIME: 0.8,       // 空喷加速持续
    LANDING_BOOST_TIME: 0.9,   // 落地喷持续
    LANDING_AIR_MIN: 0.45,     // 滞空超过此时长落地才触发落地喷
    GRAVITY: 22,               // 重力（略大于真实，手感干脆）

    /* ---- AI ---- */
    AI_COUNT: 4,               // 个人挑战赛电脑玩家数
    AI_LEVELS: [0.9, 0.95, 1.0, 1.05], // 四台电脑的速度系数（老手→新手）
    AI_RUBBER: 0.12,           // 橡皮筋强度（落后玩家越多提速越多，封顶）
    AI_RUBBER_MAX: 0.25,

    /* ---- 联机 ---- */
    NET_STATE_HZ: 12,          // 己方车辆状态上报频率
    NET_STATE_HZ_MAX: 20,      // 服务器限流上限
    NET_REMOTE_LERP: 0.22,     // 远端车插值系数（帧率相关时按 dt 缩放）
    MAX_PLAYERS: 8,            // 房间玩家上限
    FINISH_WAIT: 25,           // 第一名完赛后最长等待其余玩家（秒）
    RESPAWN_PENALTY: 1.0,      // 掉落重生冻结时间（秒）

    /* ---- 视觉 ---- */
    FOG_NEAR: 60, FOG_FAR: 520,
    CAMERA_DIST: 7.6, CAMERA_HEIGHT: 4.0, CAMERA_LAG: 8.5,
    FOV_BASE: 68, FOV_BOOST: 84,

    /* ---- 车漆色板（玩家 + AI / 联机玩家）---- */
    CAR_COLORS: [
      '#ff4d4d', '#ffa726', '#ffee58', '#66bb6a', '#26c6da',
      '#42a5f5', '#ab47bc', '#ec407a', '#8d6e63', '#26a69a',
      '#ff7043', '#9ccc65',
    ],
  };

  root.RacerConfig = CONFIG;
  if (typeof module === 'object' && module.exports) module.exports = CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
