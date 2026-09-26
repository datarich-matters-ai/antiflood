// Edit this file to adapt the app to a province or add local contacts.
// No build step: changes go live on the next deploy.
window.APP_CONFIG = {
  appName: "น้ำท่วม: เช็คระดับน้ำ & ขอความช่วยเหลือ",

  // Tap-to-call numbers shown on the ฉุกเฉิน tab.
  hotlines: [
    { name: "ปภ. (สาธารณภัย)", tel: "1784" },
    { name: "เจ็บป่วยฉุกเฉิน", tel: "1669" },
    { name: "แจ้งเหตุด่วนเหตุร้าย", tel: "191" },
    { name: "ดับเพลิง / กู้ภัย", tel: "199" },
    { name: "กรมทางหลวง (สภาพถนน)", tel: "1586" },
    { name: "กรมทางหลวงชนบท", tel: "1146" },
    { name: "กรมชลประทาน", tel: "1460" },
  ],

  // Province-specific contacts, keyed by Thai province name as ThaiWater
  // spells it. Shown when that province is selected.
  // e.g. "เชียงราย": [{ name: "ศูนย์ปภ.เขต 15 เชียงราย", tel: "053xxxxxx" }]
  provinceHotlines: {},

  links: [
    { name: "ThaiWater: ระดับน้ำทั้งประเทศ", url: "https://www.thaiwater.net/water/wl" },
    { name: "GISTDA: แผนที่พื้นที่น้ำท่วมจากดาวเทียม", url: "https://flood.gistda.or.th/" },
    { name: "ปภ.: ประกาศเตือนภัย", url: "https://www.disaster.go.th/" },
  ],

  // Only show the nearest N stations in the list.
  nearestCount: 15,
};
