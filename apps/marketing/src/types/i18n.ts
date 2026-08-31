export type LanguageCode = 'en' | 'zh-CN' | 'ko' | 'vi' | 'es';

export interface LanguageOption {
  code: LanguageCode;
  label: string;
  nativeLabel: string;
  flag: string;
}

export interface TranslationSchema {
  meta: {
    title: string;
    description: string;
  };
  nav: {
    product: string;
    howItWorks: string;
    features: string;
    industries: string;
    security: string;
    pricing: string;
    faq: string;
    startTrial: string;
    demoTag: string;
  };
  hero: {
    badge: string;
    headline: string;
    headlineHighlight: string;
    subheadline: string;
    primaryCta: string;
    secondaryCta: string;
    trialDetails: string;
    demoNotice: string;
    resourcePills: {
      rotation: string;
      singlePc: string;
      multilingual: string;
      aiCopilot: string;
      intakeKiosk: string;
      noPerSeat: string;
    };
  };
  heroPreview: {
    liveTitle: string;
    rotationOrder: string;
    waitingQueue: string;
    techStatus: string;
    upcoming: string;
    copilotProposalTitle: string;
    sampleProposal: string;
    confirmBtn: string;
    undoBtn: string;
    confirmedMessage: string;
    undoneMessage: string;
    promptSuggestions: string[];
    turnLabel: string;
    halfTurn: string;
    fullTurn: string;
    requestedLabel: string;
    walkinLabel: string;
    roomLabel: string;
  };
  industries: {
    badge: string;
    title: string;
    subtitle: string;
    items: {
      id: string;
      name: string;
      enName: string;
      desc: string;
      resourceType: string;
      rotationRule: string;
      intakeHighlight: string;
    }[];
  };
  painPoints: {
    badge: string;
    title: string;
    subtitle: string;
    columns: {
      traditional: {
        title: string;
        desc: string;
        points: string[];
      };
      genericSaas: {
        title: string;
        desc: string;
        points: string[];
      };
      geniefront: {
        title: string;
        desc: string;
        points: string[];
      };
    };
  };
  rotationSection: {
    badge: string;
    title: string;
    subtitle: string;
    explanation: string;
    features: {
      title: string;
      desc: string;
    }[];
    demo: {
      interactiveTitle: string;
      dragTip: string;
      reasonPrompt: string;
      defaultReason: string;
      saveLog: string;
      logTitle: string;
    };
  };
  singlePcSection: {
    badge: string;
    title: string;
    subtitle: string;
    desc: string;
    steps: {
      title: string;
      desc: string;
    }[];
  };
  aiSection: {
    badge: string;
    title: string;
    subtitle: string;
    menuOnboarding: {
      title: string;
      badge: string;
      desc: string;
      points: string[];
      tryScanBtn: string;
    };
    copilot: {
      title: string;
      badge: string;
      desc: string;
      points: string[];
      sampleQueries: string[];
    };
    humanInLoopNotice: string;
  };
  staffAndKiosk: {
    badge: string;
    title: string;
    subtitle: string;
    staffPwa: {
      title: string;
      desc: string;
      features: string[];
    };
    kiosk: {
      title: string;
      desc: string;
      features: string[];
      disclaimer: string;
    };
  };
  workflow: {
    badge: string;
    title: string;
    subtitle: string;
    steps: {
      time: string;
      title: string;
      desc: string;
      actor: string;
    }[];
  };
  security: {
    badge: string;
    title: string;
    subtitle: string;
    items: {
      title: string;
      desc: string;
    }[];
    posNoticeTitle: string;
    posNoticeBody: string;
    complianceNote: string;
  };
  pricing: {
    badge: string;
    title: string;
    subtitle: string;
    perLocationNotice: string;
    trialBadge: string;
    plans: {
      essential: {
        name: string;
        price: string;
        period: string;
        desc: string;
        features: string[];
        cta: string;
      };
      growth: {
        name: string;
        price: string;
        period: string;
        desc: string;
        badge: string;
        features: string[];
        cta: string;
      };
    };
    additions: {
      topupTitle: string;
      topupDesc: string;
      noSeatFeeTitle: string;
      noSeatFeeDesc: string;
      independentQuotas: string;
    };
    storefront: {
      badge: string;
      title: string;
      price: string;
      hosting: string;
      desc: string;
      points: string[];
      disclaimer: string;
      cta: string;
    };
  };
  faq: {
    badge: string;
    title: string;
    subtitle: string;
    items: {
      category: string;
      question: string;
      answer: string;
    }[];
  };
  cta: {
    title: string;
    subtitle: string;
    button: string;
    termsNotice: string;
    bookDemo: string;
  };
  footer: {
    brandBio: string;
    productCol: {
      title: string;
      items: string[];
    };
    solutionsCol: {
      title: string;
      items: string[];
    };
    securityCol: {
      title: string;
      items: string[];
    };
    disclaimer: string;
    copyright: string;
  };
  modal: {
    trialTitle: string;
    trialSubtitle: string;
    step1Title: string;
    step2Title: string;
    shopNameLabel: string;
    industryLabel: string;
    ownerNameLabel: string;
    phoneLabel: string;
    emailLabel: string;
    languageLabel: string;
    cardNumberPlaceholder: string;
    cardExpiryPlaceholder: string;
    cardCvcPlaceholder: string;
    cardZipPlaceholder: string;
    billingNotice: string;
    submitTrial: string;
    successTitle: string;
    successMessage: string;
    closeBtn: string;
    openDemoShop: string;
  };
}
