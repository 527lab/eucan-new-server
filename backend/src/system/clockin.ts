import { Request,Response } from "express";
import { valid } from "../plugins/checkvalid";
import { mailer } from "../plugins/mailer";
import logger from "../plugins/logger";
import { sql } from "../plugins/sql";
import { check_working_day } from "../plugins/dayoff_calendar";
import { digit } from "../types/types";

module.exports = async function utils(sqlPlugin:sql,log:logger,mailer:mailer,req:Request,res:Response):Promise<void>{
    const dataReceived:{[key:string]:any} = req.body;

    const account = dataReceived["account"] as string;
    const cookie = dataReceived["cookie"] as string;
    const day = dataReceived["day"];

    /*
        Type can be these values:
        0: no specfic, enter searching mode
        1: clock in
        -1: clock out
    */
    const type = dataReceived["type"] as digit;

    if(!valid(dataReceived,["account","cookie","type"])){
        res.sendStatus(400);
        return;
    }
    
    let ret = sqlPlugin.checkHash(account,cookie);
    if (ret==null){
        res.sendStatus(403);
        return;
    }
    var date = (`${type}`=="0"&&day)?new Date(day):new Date();
    if(type!=0){
        let wk = (await check_working_day(date.getFullYear(),(date.getMonth()+1).toString(),date.getDate().toString()))["status"];
        if((date.getHours()<=8 && date.getMinutes()<30)||wk==1){
            // log.logFormat(`Current time is not allowed to clock-in or clock-out. Current time: ${date.getHours()}:${date.getMinutes()}. Working status: ${wk}`);
            res.sendStatus(403);
            return;
        }
    }
    // date.setDate(date.getHours() + 8);
    log.logFormat(`${account} tries to ${type==0?"lookup clocking history":type==1?"clock-in":"clock-out"}.`)
    const returns = sqlPlugin.clockinAction(account,parseInt(`${type}`),date);
    if (returns && !Array.isArray(returns) && returns["status"] == 409) {
        // Same kind of punch less than 5 minutes after the previous one: not recorded.
        res.status(409).json({ status: 409, message: type == 1 ? "已打過上班卡" : "已打過下班卡" });
        return;
    }
    res.json(returns);

}