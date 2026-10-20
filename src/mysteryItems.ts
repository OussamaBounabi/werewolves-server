import { existsSync } from "node:fs";

import { catalog } from "./guess.js";

/**
 * Mystery Item's things to find, by category: English | French | Arabic, one per line (50 each, the best known; 49 fruits and vegetables: Ginger's picture never came).
 * An item's id is its category and English name ("animals-polar-bear"): its picture is data/mystery/img/<id>.webp.
 * Countries are the 50 best known, by FIFA code: their names and flags are Guess Who's.
 */
const LISTS: Record<string, string> = {
  animals: `
Lion|Lion|أسد
Tiger|Tigre|نمر
Elephant|Éléphant|فيل
Giraffe|Girafe|زرافة
Zebra|Zèbre|حمار وحشي
Monkey|Singe|قرد
Gorilla|Gorille|غوريلا
Bear|Ours|دب
Polar bear|Ours polaire|دب قطبي
Panda|Panda|باندا
Kangaroo|Kangourou|كنغر
Koala|Koala|كوالا
Wolf|Loup|ذئب
Fox|Renard|ثعلب
Rabbit|Lapin|أرنب
Squirrel|Écureuil|سنجاب
Deer|Cerf|غزال
Camel|Chameau|جمل
Horse|Cheval|حصان
Donkey|Âne|حمار
Cow|Vache|بقرة
Sheep|Mouton|خروف
Goat|Chèvre|ماعز
Dog|Chien|كلب
Cat|Chat|قطة
Hedgehog|Hérisson|قنفذ
Hippopotamus|Hippopotame|فرس النهر
Rhinoceros|Rhinocéros|وحيد القرن
Cheetah|Guépard|فهد
Crocodile|Crocodile|تمساح
Snake|Serpent|ثعبان
Turtle|Tortue|سلحفاة
Frog|Grenouille|ضفدع
Chameleon|Caméléon|حرباء
Shark|Requin|قرش
Dolphin|Dauphin|دلفين
Whale|Baleine|حوت
Octopus|Pieuvre|أخطبوط
Crab|Crabe|سلطعون
Owl|Hibou|بومة
Eagle|Aigle|نسر
Parrot|Perroquet|ببغاء
Penguin|Manchot|بطريق
Flamingo|Flamant rose|فلامنغو
Peacock|Paon|طاووس
Chicken|Poule|دجاجة
Duck|Canard|بطة
Ostrich|Autruche|نعامة
Butterfly|Papillon|فراشة
Bee|Abeille|نحلة`,
  food: `
Pizza|Pizza|بيتزا
Burger|Burger|برغر
Sandwich|Sandwich|ساندويتش
Hot dog|Hot-dog|هوت دوغ
French fries|Frites|بطاطا مقلية
Spaghetti|Spaghettis|سباغيتي
Lasagna|Lasagnes|لازانيا
Rice|Riz|أرز
Couscous|Couscous|كسكس
Tajine|Tajine|طاجين
Shawarma|Chawarma|شاورما
Kebab|Kebab|كباب
Falafel|Falafel|فلافل
Hummus|Houmous|حمص بالطحينة
Soup|Soupe|حساء
Salad|Salade|سلطة
Sushi|Sushi|سوشي
Tacos|Tacos|تاكو
Noodles|Nouilles|نودلز
Omelette|Omelette|عجة
Fried egg|Œuf au plat|بيض مقلي
Roast chicken|Poulet rôti|دجاج مشوي
Steak|Steak|شريحة لحم
Grilled fish|Poisson grillé|سمك مشوي
Sausage|Saucisse|نقانق
Chicken nuggets|Nuggets de poulet|ناغتس الدجاج
Bread|Pain|خبز
Croissant|Croissant|كرواسون
Cheese|Fromage|جبن
Butter|Beurre|زبدة
Yogurt|Yaourt|زبادي
Honey|Miel|عسل
Jam|Confiture|مربى
Cereal|Céréales|حبوب الإفطار
Pancakes|Crêpes épaisses|فطائر بانكيك
Waffle|Gaufre|وافل
Cake|Gâteau|كعكة
Cupcake|Cupcake|كب كيك
Cookie|Cookie|كوكيز
Donut|Beignet|دونات
Ice cream|Glace|آيس كريم
Chocolate|Chocolat|شوكولاتة
Candy|Bonbon|حلوى
Popcorn|Pop-corn|فشار
Baklava|Baklava|بقلاوة
Kunafa|Knafeh|كنافة
Milk|Lait|حليب
Tea|Thé|شاي
Coffee|Café|قهوة
Orange juice|Jus d'orange|عصير برتقال`,
  fruits: `
Apple|Pomme|تفاح
Banana|Banane|موز
Orange|Orange|برتقال
Lemon|Citron|ليمون
Strawberry|Fraise|فراولة
Grapes|Raisin|عنب
Watermelon|Pastèque|بطيخ
Melon|Melon|شمام
Pineapple|Ananas|أناناس
Mango|Mangue|مانجو
Peach|Pêche|خوخ
Pear|Poire|إجاص
Cherry|Cerise|كرز
Kiwi|Kiwi|كيوي
Pomegranate|Grenade|رمان
Fig|Figue|تين
Dates|Dattes|تمر
Coconut|Noix de coco|جوز الهند
Avocado|Avocat|أفوكادو
Apricot|Abricot|مشمش
Plum|Prune|برقوق
Raspberry|Framboise|توت العليق
Blueberry|Myrtille|توت أزرق
Olive|Olive|زيتون
Tomato|Tomate|طماطم
Potato|Pomme de terre|بطاطا
Carrot|Carotte|جزر
Onion|Oignon|بصل
Garlic|Ail|ثوم
Cucumber|Concombre|خيار
Lettuce|Laitue|خس
Cabbage|Chou|ملفوف
Broccoli|Brocoli|بروكلي
Cauliflower|Chou-fleur|قرنبيط
Eggplant|Aubergine|باذنجان
Zucchini|Courgette|كوسة
Bell pepper|Poivron|فلفل حلو
Chili pepper|Piment|فلفل حار
Corn|Maïs|ذرة
Peas|Petits pois|بازلاء
Green beans|Haricots verts|فاصولياء خضراء
Pumpkin|Citrouille|يقطين
Mushroom|Champignon|فطر
Spinach|Épinards|سبانخ
Radish|Radis|فجل
Beetroot|Betterave|شمندر
Sweet potato|Patate douce|بطاطا حلوة
Artichoke|Artichaut|خرشوف
Turnip|Navet|لفت`,
  things: `
Phone|Téléphone|هاتف
Laptop|Ordinateur portable|حاسوب محمول
Television|Télévision|تلفاز
Remote control|Télécommande|جهاز التحكم
Headphones|Casque audio|سماعات
Camera|Appareil photo|كاميرا
Watch|Montre|ساعة يد
Alarm clock|Réveil|منبه
Glasses|Lunettes|نظارات
Umbrella|Parapluie|مظلة
Key|Clé|مفتاح
Wallet|Portefeuille|محفظة
Backpack|Sac à dos|حقيبة ظهر
Book|Livre|كتاب
Pen|Stylo|قلم
Pencil|Crayon|قلم رصاص
Scissors|Ciseaux|مقص
Calculator|Calculatrice|آلة حاسبة
Chair|Chaise|كرسي
Table|Table|طاولة
Bed|Lit|سرير
Sofa|Canapé|أريكة
Lamp|Lampe|مصباح
Light bulb|Ampoule|مصباح كهربائي
Mirror|Miroir|مرآة
Pillow|Oreiller|وسادة
Refrigerator|Réfrigérateur|ثلاجة
Washing machine|Machine à laver|غسالة
Microwave|Micro-ondes|ميكروويف
Kettle|Bouilloire|غلاية
Iron|Fer à repasser|مكواة
Vacuum cleaner|Aspirateur|مكنسة كهربائية
Broom|Balai|مكنسة
Fan|Ventilateur|مروحة
Cup|Tasse|فنجان
Spoon|Cuillère|ملعقة
Fork|Fourchette|شوكة
Plate|Assiette|صحن
Bottle|Bouteille|قارورة
Toothbrush|Brosse à dents|فرشاة أسنان
Comb|Peigne|مشط
Soap|Savon|صابون
Towel|Serviette|منشفة
Candle|Bougie|شمعة
Hammer|Marteau|مطرقة
Screwdriver|Tournevis|مفك
Ladder|Échelle|سلم
Flashlight|Lampe torche|مصباح يدوي
Football|Ballon de football|كرة قدم
Teddy bear|Ours en peluche|دمية دب`,
  vehicles: `
Car|Voiture|سيارة
Bus|Bus|حافلة
School bus|Bus scolaire|حافلة مدرسية
Double-decker bus|Bus à impériale|حافلة بطابقين
Taxi|Taxi|سيارة أجرة
Police car|Voiture de police|سيارة شرطة
Ambulance|Ambulance|سيارة إسعاف
Fire truck|Camion de pompiers|شاحنة إطفاء
Truck|Camion|شاحنة
Garbage truck|Camion-poubelle|شاحنة نفايات
Tow truck|Dépanneuse|شاحنة سحب
Cement mixer|Bétonnière|خلاطة إسمنت
Pickup truck|Pick-up|سيارة بيك آب
Van|Camionnette|شاحنة صغيرة
Jeep|Jeep|جيب
Limousine|Limousine|ليموزين
Race car|Voiture de course|سيارة سباق
Motorcycle|Moto|دراجة نارية
Scooter|Scooter|سكوتر
Bicycle|Vélo|دراجة هوائية
Tricycle|Tricycle|دراجة ثلاثية
Electric scooter|Trottinette électrique|سكوتر كهربائي
Skateboard|Skateboard|لوح تزلج
Quad bike|Quad|دراجة رباعية
Tractor|Tracteur|جرار
Excavator|Pelleteuse|حفارة
Bulldozer|Bulldozer|جرافة
Forklift|Chariot élévateur|رافعة شوكية
Tank|Char|دبابة
Train|Train|قطار
Tram|Tramway|ترامواي
Metro|Métro|مترو
Cable car|Téléphérique|تلفريك
Airplane|Avion|طائرة
Helicopter|Hélicoptère|مروحية
Fighter jet|Avion de chasse|طائرة مقاتلة
Hot air balloon|Montgolfière|منطاد
Rocket|Fusée|صاروخ
Drone|Drone|طائرة مسيرة
Ship|Navire|سفينة
Cruise ship|Paquebot|سفينة سياحية
Sailboat|Voilier|مركب شراعي
Speedboat|Hors-bord|قارب سريع
Yacht|Yacht|يخت
Fishing boat|Bateau de pêche|قارب صيد
Canoe|Canoë|زورق
Submarine|Sous-marin|غواصة
Jet ski|Jet-ski|دراجة مائية
Sled|Luge|زلاجة
Horse carriage|Calèche|عربة خيل`,
  places: `
Beach|Plage|شاطئ
Desert|Désert|صحراء
Forest|Forêt|غابة
Jungle|Jungle|أدغال
Mountain|Montagne|جبل
Volcano|Volcan|بركان
Island|Île|جزيرة
Waterfall|Cascade|شلال
Lake|Lac|بحيرة
River|Rivière|نهر
Cave|Grotte|كهف
Farm|Ferme|مزرعة
Garden|Jardin|حديقة منزلية
Park|Parc|حديقة عامة
Zoo|Zoo|حديقة حيوانات
Playground|Aire de jeux|ساحة ألعاب
Amusement park|Parc d'attractions|مدينة ملاهي
School|École|مدرسة
Classroom|Salle de classe|قسم دراسي
University|Université|جامعة
Library|Bibliothèque|مكتبة
Museum|Musée|متحف
Hospital|Hôpital|مستشفى
Pharmacy|Pharmacie|صيدلية
Mosque|Mosquée|مسجد
Airport|Aéroport|مطار
Train station|Gare|محطة قطار
Port|Port|ميناء
Gas station|Station-service|محطة بنزين
Police station|Commissariat|مركز شرطة
Fire station|Caserne de pompiers|مركز إطفاء
Bank|Banque|بنك
Post office|Bureau de poste|مكتب بريد
Supermarket|Supermarché|سوبر ماركت
Market|Marché|سوق
Shopping mall|Centre commercial|مركز تجاري
Restaurant|Restaurant|مطعم
Café|Café|مقهى
Bakery|Boulangerie|مخبزة
Barbershop|Salon de coiffure|محل حلاقة
Hotel|Hôtel|فندق
Cinema|Cinéma|سينما
Stadium|Stade|ملعب
Swimming pool|Piscine|مسبح
Gym|Salle de sport|قاعة رياضة
Castle|Château|قلعة
Lighthouse|Phare|منارة
Bridge|Pont|جسر
Skyscraper|Gratte-ciel|ناطحة سحاب
Kitchen|Cuisine|مطبخ`,
};

/** The 50 best-known countries (FIFA codes), shown by their flag. */
const COUNTRIES = `
ALG MAR TUN EGY KSA QAT UAE IRQ JOR PLE LIB SYR KUW OMA FRA ESP ITA GER ENG POR NED BEL SUI SWE NOR DEN GRE TUR
RUS POL CRO BRA ARG URU COL CHI MEX USA CAN JPN KOR CHN IND PAK IRN AUS NGA SEN CMR RSA`;

export const MYSTERY_CATEGORIES = [...Object.keys(LISTS), "countries"];

export type Item = { id: string; cat: string; name: { en: string; fr: string; ar: string }; flag?: string; photo?: boolean };

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const ITEMS: Item[] = [
  ...Object.entries(LISTS).flatMap(([cat, list]) =>
    list
      .trim()
      .split("\n")
      .map((line) => {
        const [en, fr, ar] = line.split("|").map((s) => s.trim());
        return { id: `${cat}-${slug(en)}`, cat, name: { en, fr, ar } };
      }),
  ),
  ...COUNTRIES.trim()
    .split(/\s+/)
    .map((code) => {
      const n = catalog.nations.find((x) => x.id === code);
      if (!n) throw new Error(`no nation ${code}`);
      return { id: `countries-${code}`, cat: "countries", name: n.name, flag: n.flag };
    }),
];

// Who has his picture (data/mystery/img/<id>.webp): dropped in, they show after a restart.
for (const i of ITEMS) i.photo = existsSync(new URL(`../data/mystery/img/${i.id}.webp`, import.meta.url));
const byId = new Map(ITEMS.map((i) => [i.id, i]));
export const item = (id: string) => byId.get(id);
export const itemsOf = (cat: string) => ITEMS.filter((i) => i.cat === cat);
