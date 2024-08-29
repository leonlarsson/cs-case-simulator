"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { waitUntil } from "@vercel/functions";
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
import { CaseDataType, ItemType, ItemTypeDB } from "@/types";
import db from "@/db";
import { items } from "@/db/schema";
import getItem from "@/utils/getItem";
import casesLocal from "@/lib/data/cases.json";
import souvenirCasesLocal from "@/lib/data/souvenir.json";
import customCasesLocal from "@/lib/data/customCases.json";

// Get cases on the server to prevent changing the data on the client before it's sent to the server
const casesData: CaseDataType[] = [
  ...casesLocal,
  ...customCasesLocal,
  ...souvenirCasesLocal,
];

const dataSchema = z.object({
  caseData: z.object({
    id: z.string(),
    name: z.string(),
    image: z
      .string()
      .refine(
        url =>
          url.startsWith("https://raw.githubusercontent.com/ByMykel") ||
          url.startsWith("https://steamcdn-a.akamaihd.net/apps/730/icons"),
      ),
  }),
  itemData: z.object({
    id: z.string(),
    name: z.string(),
    rarity: z.object({
      // id: z.string(),
      name: z.string(),
      // color: z.string(),
    }),
    phase: z.string().optional().nullable(),
    image: z
      .string()
      .refine(
        url =>
          url.startsWith("https://raw.githubusercontent.com/ByMykel") ||
          url.startsWith("https://steamcdn-a.akamaihd.net/apps/730/icons"),
      ),
  }),
});

// Gets a case from the provided caseId, unboxes an item, adds the item to DB, and returns the unboxed item
export const unboxCase = async (caseId: string): Promise<ItemType | false> => {
  const caseData = casesData.find(x => x.id === caseId);
  if (!caseData) {
    console.error(`unboxCase: Case id ${caseId} not found`);
    return false;
  }

  const openedItem = getItem(caseData);

  // Add item to DB if it's not a custom case
  if (!caseData.id.startsWith("crate-custom")) {
    waitUntil(addItemToDB(caseData, openedItem));
  }

  return openedItem;
};

// Adds a single item to the database
export const addItemToDB = async (
  caseData: CaseDataType,
  itemData: ItemType,
): Promise<boolean> => {
  // Validate data
  const zodReturn = dataSchema.safeParse({ caseData, itemData });
  if (!zodReturn.success) {
    console.error("addItemToDB: Error validating data:", zodReturn.error);
    return false;
  }

  // Get unboxerId from cookies
  const unboxerId = await getOrCreateUnboxerIdCookie();

  const { id: caseId, name: caseName, image: caseImage } = caseData;
  const {
    id: itemId,
    name: itemName,
    rarity,
    phase,
    image: itemImage,
  } = itemData;

  try {
    await db.insert(items).values({
      caseId,
      caseName,
      caseImage,
      itemId,
      itemName,
      rarity: rarity.name,
      phase,
      itemImage,
      unboxerId,
    });

    return true;
  } catch (error) {
    console.error("Error adding item:", error);
    return false;
  }
};

// Adds multiple items to the database
export const addItemsToDB = async (
  data: {
    caseData: { id: string; name: string; image: string };
    itemData: ItemType;
  }[],
): Promise<boolean> => {
  // Validate data
  const zodReturn = z.array(dataSchema).safeParse(data);
  if (!zodReturn.success) {
    console.error("addItemsToDB: Error validating data:", zodReturn.error);
    return false;
  }

  // Get unboxerId from cookies
  const unboxerId = await getOrCreateUnboxerIdCookie();

  try {
    await db.insert(items).values(
      data.map(item => ({
        caseId: item.caseData.id,
        caseName: item.caseData.name,
        caseImage: item.caseData.image,
        itemId: item.itemData.id,
        itemName: item.itemData.name,
        rarity: item.itemData.rarity.name,
        phase: item.itemData.phase ?? null,
        itemImage: item.itemData.image,
        unboxerId,
      })),
    );

    return true;
  } catch (error) {
    console.error("Error adding items:", error);
    return false;
  }
};

export const getItemsFromDB = async (
  onlyCoverts?: boolean,
  onlyPersonal?: boolean,
): Promise<ItemTypeDB[] | false> => {
  try {
    const rows = await db
      .select()
      .from(items)
      .where(
        and(
          onlyCoverts ? itemIsCovert : undefined,
          onlyPersonal
            ? itemIsPersonal(await getOrCreateUnboxerIdCookie())
            : undefined,
        ),
      )
      .orderBy(desc(items.id))
      .limit(100);

    return rows;
  } catch (error) {
    console.error("Error getting items:", error);
    return false;
  }
};

export const getTotalItemsFromDB = async (
  onlyCoverts?: boolean,
  onlyPersonal?: boolean,
): Promise<number | false> => {
  try {
    const totalItems = await db
      .select({
        value: onlyCoverts || onlyPersonal ? count() : max(items.id),
      })
      .from(items)
      .where(
        and(
          onlyCoverts ? itemIsCovert : undefined,
          onlyPersonal
            ? itemIsPersonal(await getOrCreateUnboxerIdCookie())
            : undefined,
        ),
      );

    return totalItems[0].value ?? 0;
  } catch (error) {
    console.error("Error getting total items:", error);
    return false;
  }
};

// Gets or creates unboxerId cookie
// First checks if the unboxerId cookie is a valid UUID
// If it is, it returns the value
// If it isn't, it generates a new UUID and sets it as the unboxerId cookie
// Returns the new unboxerId
export const getOrCreateUnboxerIdCookie = async (): Promise<string> => {
  const existingUnboxerId = cookies().get("unboxerId");

  if (existingUnboxerId) {
    const isValidUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        existingUnboxerId.value,
      );
    if (isValidUUID) return existingUnboxerId.value;
  }

  const newUnboxerId = crypto.randomUUID();

  cookies().set("unboxerId", newUnboxerId, {
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    httpOnly: true,
  });

  return newUnboxerId;
};

const itemIsCovert = inArray(items.rarity, ["Covert", "Extraordinary"]);
const itemIsPersonal = (id: string) => eq(items.unboxerId, id);
