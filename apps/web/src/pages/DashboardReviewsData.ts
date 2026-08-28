export interface CustomerReviewItem {
  id: string;
  customerName: string;
  avatarText: string;
  rating: number;
  platform: 'google' | 'yelp' | 'in_store' | 'redbook';
  platformLabel: string;
  timeAgo: string;
  technicianName?: string;
  serviceName: string;
  content: string;
  sentiment: 'positive' | 'neutral' | 'suggestion';
  sentimentTag: string;
  highlights: string[];
}

export const BACKEND_REVIEWS_DATA: {
  overallScore: number;
  totalReviewCount: number;
  satisfactionRate: number;
  aiSummary: {
    overview: string;
    topKeywords: { tag: string; count: number; sentiment: 'positive' | 'warning' }[];
    topStaff: {
      membershipId: string;
      name: string;
      tier: string;
      reviewCount: number;
      rating: number;
      specialty: string;
    }[];
    actionableSuggestions: {
      type: 'warning' | 'tip' | 'info';
      title: string;
      description: string;
    }[];
  };
  recentReviews: CustomerReviewItem[];
} = {
  overallScore: 4.92,
  totalReviewCount: 1286,
  satisfactionRate: 98.4,
  aiSummary: {
    overview:
      '近 30 天全平台客户评价综合表现极为优异。顾客对「技师手法沉浸到位」、「环境私密安静」、「肩颈腰肌酸痛缓解效果明显」给予了最高频好评；到店前电子健康排查与自选精油服务被多位 VIP 顾客专门表扬。',
    topKeywords: [
      { tag: '手法深透到位', count: 382, sentiment: 'positive' },
      { tag: '环境静谧私密', count: 315, sentiment: 'positive' },
      { tag: '精油芳香好闻', count: 240, sentiment: 'positive' },
      { tag: '前台热情有礼', count: 195, sentiment: 'positive' },
      { tag: '全程无强制推销', count: 160, sentiment: 'positive' },
      { tag: 'iPad扫码便捷', count: 130, sentiment: 'positive' },
      { tag: '高峰等候超15m', count: 4, sentiment: 'warning' },
      { tag: '2号包厢空调偏凉', count: 2, sentiment: 'warning' },
    ],
    topStaff: [
      {
        membershipId: 'staff-1',
        name: 'Linda',
        tier: '总监技师',
        reviewCount: 98,
        rating: 4.98,
        specialty: '肩颈斜方肌深度放松 / 沉浸式精油',
      },
      {
        membershipId: 'staff-2',
        name: 'David',
        tier: '高级技师',
        reviewCount: 76,
        rating: 4.94,
        specialty: '深层穴位加压 / 运动腰肌拉伸',
      },
      {
        membershipId: 'staff-3',
        name: 'Coco',
        tier: '高级技师',
        reviewCount: 64,
        rating: 4.91,
        specialty: '传统经络足底反射区 / 芳香排浊',
      },
    ],
    actionableSuggestions: [
      {
        type: 'warning',
        title: '高峰期等候时长预警',
        description: '周六下午 14:00-18:00 客流集中，等候时长平均达 14 分钟，建议周末该时段增派 1 名轮牌机动技师。',
      },
      {
        type: 'tip',
        title: '2 号包厢空调温控建议',
        description: '近期有 2 位顾客反馈 2 号包厢空调风口偏凉，建议前台将该包厢出风口调至微风向上，并设定恒温 24°C。',
      },
      {
        type: 'info',
        title: '精油加项转化率提升',
        description: '「生姜暖体」与「薰衣草助眠」精油好评率超 99%，前台在到店排查时可继续作为主推加项。',
      },
    ],
  },
  recentReviews: [
    {
      id: 'rev-1',
      customerName: 'Lisa Chen',
      avatarText: 'LC',
      rating: 5,
      platform: 'google',
      platformLabel: 'Google 真实好评',
      timeAgo: '2 小时前',
      technicianName: 'Linda (总监)',
      serviceName: '深度减压精油 SPA 60m',
      content:
        '太舒服了！Linda 老师手法非常沉浸专业，左肩和后颈部酸痛严重，调理后整个人轻盈了许多。环境很私密安静，前台用 iPad 扫码填表也很方便，完全没有推销，已经办了次卡！',
      sentiment: 'positive',
      sentimentTag: '😊 极度推荐',
      highlights: ['手法沉浸专业', '肩颈酸痛明显缓解', '无推销'],
    },
    {
      id: 'rev-2',
      customerName: 'Michael W.',
      avatarText: 'MW',
      rating: 5,
      platform: 'yelp',
      platformLabel: 'Yelp 认证评价',
      timeAgo: '5 小时前',
      technicianName: 'David (高级)',
      serviceName: '泰式古法拉伸 60m',
      content:
        'David 技师力道很足，按穴位非常准，腰肌拉伸到位。店里非常干净卫生，毛巾都是独立密封消毒的，前台接待很热情，强烈推荐！',
      sentiment: 'positive',
      sentimentTag: '⭐ 体验极佳',
      highlights: ['穴位精准', '环境卫生干净', '接待热情'],
    },
    {
      id: 'rev-3',
      customerName: 'Jennifer L.',
      avatarText: 'JL',
      rating: 5,
      platform: 'in_store',
      platformLabel: '店内电子签署评价',
      timeAgo: '昨日 20:30',
      technicianName: 'Coco (高级)',
      serviceName: '传统经络足疗 45m',
      content:
        '足疗非常舒服，生姜精油热敷很暖和。唯一小建议是周末晚上人有点多稍微等了 10 分钟，但技师的服务完全弥补了等待。',
      sentiment: 'suggestion',
      sentimentTag: '💡 包含建议',
      highlights: ['足疗很舒服', '等候稍长', '服务细致'],
    },
  ],
};
